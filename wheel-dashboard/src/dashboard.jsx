import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import {
  ShieldCheck,
  AlertTriangle,
  CalendarDays,
  Target,
  Search,
  Activity,
  BarChart3,
  Layers3,
  X,
  RefreshCw,
  Database,
} from "lucide-react";
import { wheelShortlist } from "./data/wheelShortlist";
import { SeasonalityBadge } from "./components/SeasonalityBadge.jsx";
import { getTickerDisplayMeta, QUALITY_TIER_STYLE, USER_PREFS } from "./tickerMeta.js";

const API_BASE = "http://127.0.0.1:3001";
const JournalPopPanel = React.lazy(() => import("./components/JournalPopPanel.jsx"));

function nextNFridays(n = 6) {
  const fridays = [];
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (fridays.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() === 5) {
      fridays.push(d.toISOString().slice(0, 10));
    }
  }
  return fridays;
}

const DEFAULT_EXPIRATIONS = nextNFridays(6);
const DEBUG_COMPARE = false;

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
  limit: 120,
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

function isValidLevel(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0;
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
  if (supportStatus === "current_below_support") {
    score -= 30;
    reasons.push("malus prix sous support");
  } else if (supportStatus === "strike_above_support" || supportStatus === "room_above_support") {
    score -= 12;
    reasons.push("malus strike au-dessus support");
  } else if (supportStatus === "strike_near_support" || supportStatus === "near_support") {
    score += 2;
    reasons.push("strike proche support");
  } else if (supportStatus === "strike_below_support" || supportStatus === "below_support") {
    score += 8;
    reasons.push("strike sous support");
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

function computeIbkrPriorityScore(candidate) {
  let score = 0;
  const reasons = [];
  const safe = candidate?.safeStrike ?? null;
  const aggressive = candidate?.aggressiveStrike ?? null;
  const targetPremium = Number(candidate?.targetPremium ?? candidate?.minPremium);
  const premiumSafe = Number(
    safe?.premiumUsed ?? safe?.primeUsed ?? safe?.bid ?? safe?.mid
  );
  const premiumAgg = Number(
    aggressive?.premiumUsed ?? aggressive?.primeUsed ?? aggressive?.bid ?? aggressive?.mid
  );
  const bestPremium = Math.max(
    Number.isFinite(premiumSafe) ? premiumSafe : Number.NEGATIVE_INFINITY,
    Number.isFinite(premiumAgg) ? premiumAgg : Number.NEGATIVE_INFINITY
  );
  if (Number.isFinite(targetPremium) && targetPremium > 0 && Number.isFinite(bestPremium)) {
    if (bestPremium >= targetPremium) {
      score += 30;
      reasons.push("prime>=objectif");
    }
  }

  const spreadPct = Number(
    safe?.liquidity?.spreadPct ??
      aggressive?.liquidity?.spreadPct ??
      safe?.spreadPct ??
      aggressive?.spreadPct
  );
  if (Number.isFinite(spreadPct)) {
    if (spreadPct <= 10) {
      score += 20;
      reasons.push("spread<=10%");
    } else if (spreadPct > 20) {
      score -= 20;
      reasons.push("spread>20%");
    }
  }

  const iv = Number(
    safe?.impliedVolatility ??
      aggressive?.impliedVolatility ??
      candidate?.diagnosticsV12?.safeStrikeIv ??
      candidate?.diagnosticsV12?.atmIv
  );
  if (Number.isFinite(iv) && iv >= 0.35) {
    score += 15;
    reasons.push("iv>=0.35");
  }

  const trend = String(candidate?.trend ?? candidate?.technicals?.trend ?? "")
    .trim()
    .toLowerCase();
  const momentum = String(candidate?.momentum ?? candidate?.technicals?.momentum ?? "")
    .trim()
    .toLowerCase();
  if ((trend === "bullish" || trend === "neutral") && momentum !== "negative") {
    score += 15;
    reasons.push("trend/momentum ok");
  }

  const supportStatus = String(
    candidate?.supportStatus ?? candidate?.supportResistance?.supportStatus ?? ""
  )
    .trim()
    .toLowerCase();
  if (
    supportStatus === "strike_near_support" ||
    supportStatus === "near_support" ||
    supportStatus === "strike_below_support" ||
    supportStatus === "below_support"
  ) {
    score += 10;
    reasons.push("support cohérent");
  }

  const earningsDaysUntil = Number(candidate?.earningsDaysUntil);
  const hasUpcomingEarnings =
    candidate?.hasUpcomingEarningsBeforeExpiration === true ||
    candidate?.hasEarningsBeforeExpiration === true ||
    (Number.isFinite(earningsDaysUntil) && earningsDaysUntil >= 0 && earningsDaysUntil <= 7);
  if (hasUpcomingEarnings) {
    score -= 25;
    reasons.push("earnings proche");
  } else {
    score += 10;
    reasons.push("pas d earnings proche");
  }

  const expectedMoveIncomplete = candidate?.expectedMoveIncomplete === true;
  const expectedMoveStatus = String(candidate?.expectedMoveStatus || "")
    .trim()
    .toUpperCase();
  const optionDataIncomplete =
    expectedMoveIncomplete ||
    expectedMoveStatus.includes("MISSING") ||
    (!Number.isFinite(Number(bestPremium)) && !Number.isFinite(spreadPct));
  if (optionDataIncomplete) {
    score -= 15;
    reasons.push("options incomplètes");
  }

  return { score, reasons: reasons.slice(0, 6) };
}

function gradeLeg({ spreadPct, weeklyYieldPct, popDecimal }) {
  const spread = Number.isFinite(Number(spreadPct)) ? Number(spreadPct) : null;
  const yldRaw = Number(weeklyYieldPct);
  const yld = Number.isFinite(yldRaw) && yldRaw > 0 ? yldRaw : null;
  const pop = Number.isFinite(Number(popDecimal)) ? Number(popDecimal) * 100 : null;
  if (spread == null) return "WATCH";
  if (spread > 35) return "REJECT";
  if (yld == null) return "WATCH";
  if (spread <= 10 && yld >= 0.50 && (pop == null || pop >= 80)) return "A";
  if (spread <= 20 && yld >= 0.50 && (pop == null || pop >= 75)) return "B";
  if (spread <= 35 && yld >= 0.40) return "WATCH";
  return "REJECT";
}

function getAggressivePriorityGrade({ spreadPct, weeklyYieldPct, popDecimal, distancePct }) {
  const spread = Number.isFinite(Number(spreadPct)) ? Number(spreadPct) : null;
  const yld = Number.isFinite(Number(weeklyYieldPct)) ? Number(weeklyYieldPct) : null;
  const popPct = Number.isFinite(Number(popDecimal)) ? Number(popDecimal) * 100 : null;
  const dist = Number.isFinite(Number(distancePct)) ? Number(distancePct) : null;
  if (spread == null || yld == null || popPct == null || dist == null) return null;
  if (yld < 1.0) return null;
  if (spread > 30) return null;
  if (popPct < 75) return null;
  if (dist > -5) return null;
  return spread <= 15 ? "A" : "B";
}

const MODE_GRADE_RANK = {
  AGGRESSIVE_A: 8,
  AGGRESSIVE_B: 7,
  SAFE_A: 6,
  SAFE_B: 5,
  AGGRESSIVE_WATCH: 4,
  SAFE_WATCH: 3,
  WATCH: 2,
  REJECT: 0,
};

function getModeGradeRank(mode, grade) {
  const normalizedMode = String(mode || "").trim().toUpperCase();
  const normalizedGrade = String(grade || "").trim().toUpperCase();
  if (normalizedGrade === "REJECT") return MODE_GRADE_RANK.REJECT;
  if (normalizedGrade === "WATCH") {
    if (normalizedMode === "AGGRESSIVE") return MODE_GRADE_RANK.AGGRESSIVE_WATCH;
    if (normalizedMode === "SAFE") return MODE_GRADE_RANK.SAFE_WATCH;
    return MODE_GRADE_RANK.WATCH;
  }
  if (normalizedGrade === "A") {
    return normalizedMode === "AGGRESSIVE" ? MODE_GRADE_RANK.AGGRESSIVE_A : MODE_GRADE_RANK.SAFE_A;
  }
  if (normalizedGrade === "B") {
    return normalizedMode === "AGGRESSIVE" ? MODE_GRADE_RANK.AGGRESSIVE_B : MODE_GRADE_RANK.SAFE_B;
  }
  return MODE_GRADE_RANK.REJECT;
}

function getFinalDisplayRecommendation(item) {
  const diag = item?.recommendationDiagnostics ?? null;
  const safeGrade = String(item?.safeGrade ?? diag?.safeGrade ?? "").toUpperCase() || null;
  const aggressiveGrade = String(item?.aggressiveGrade ?? diag?.aggressiveGrade ?? "").toUpperCase() || null;
  const safeYieldPct = item?.safeStrike?.weeklyYield ?? diag?.safeYieldPct ?? null;
  const aggressiveYieldPct = item?.aggressiveStrike?.weeklyYield ?? diag?.aggressiveYieldPct ?? null;
  const safeSpreadPct =
    item?.safeStrike?.liquidity?.spreadPct ?? item?.safeStrike?.spreadPct ?? diag?.safeSpreadPct ?? null;
  const aggressiveSpreadPct =
    item?.aggressiveStrike?.liquidity?.spreadPct ??
    item?.aggressiveStrike?.spreadPct ??
    diag?.aggressiveSpreadPctDisplay ??
    diag?.aggressiveSpreadPct ??
    null;
  const safePopDecimal =
    item?.safeStrike?.popProfitEstimated ?? item?.safeStrike?.popEstimate ?? null;
  const aggressivePopDecimal =
    item?.aggressiveStrike?.popProfitEstimated ??
    item?.aggressiveStrike?.popEstimate ??
    diag?.aggressivePop ??
    null;
  const safeDistancePct = item?.safeStrike?.distancePct ?? diag?.safeDistancePct ?? null;
  const aggressiveDistancePct =
    item?.aggressiveStrike?.distancePct ?? diag?.aggressiveDistancePctDisplay ?? diag?.aggressiveDistancePct ?? null;

  const aggressivePriorityGrade = getAggressivePriorityGrade({
    spreadPct: aggressiveSpreadPct,
    weeklyYieldPct: aggressiveYieldPct,
    popDecimal: aggressivePopDecimal,
    distancePct: aggressiveDistancePct,
  });
  const effectiveAggressiveGrade = aggressivePriorityGrade ?? aggressiveGrade;
  const safeRank = getModeGradeRank("SAFE", safeGrade);
  const aggressiveRank = getModeGradeRank("AGGRESSIVE", effectiveAggressiveGrade);

  const derivedSafeGrade = gradeLeg({
    spreadPct: safeSpreadPct,
    weeklyYieldPct: safeYieldPct,
    popDecimal: safePopDecimal,
  });
  const derivedAggressiveGrade = gradeLeg({
    spreadPct: aggressiveSpreadPct,
    weeklyYieldPct: aggressiveYieldPct,
    popDecimal: aggressivePopDecimal,
  });
  const fallbackSafeRank = getModeGradeRank("SAFE", derivedSafeGrade);
  const fallbackAggressiveRank = getModeGradeRank(
    "AGGRESSIVE",
    aggressivePriorityGrade ?? derivedAggressiveGrade
  );

  let finalDisplayMode = "REJECT";
  let finalDisplayGrade = "REJECT";
  let finalRank = MODE_GRADE_RANK.REJECT;

  if (safeRank === MODE_GRADE_RANK.REJECT && aggressiveRank === MODE_GRADE_RANK.REJECT) {
    if (fallbackAggressiveRank > fallbackSafeRank && fallbackAggressiveRank > MODE_GRADE_RANK.REJECT) {
      finalDisplayMode = "AGGRESSIVE";
      finalDisplayGrade = aggressivePriorityGrade ?? derivedAggressiveGrade;
      finalRank = fallbackAggressiveRank;
    } else if (fallbackSafeRank > MODE_GRADE_RANK.REJECT) {
      finalDisplayMode = "SAFE";
      finalDisplayGrade = derivedSafeGrade;
      finalRank = fallbackSafeRank;
    }
  } else if (aggressiveRank > safeRank) {
    finalDisplayMode = "AGGRESSIVE";
    finalDisplayGrade = effectiveAggressiveGrade;
    finalRank = aggressiveRank;
  } else if (safeRank > MODE_GRADE_RANK.REJECT) {
    finalDisplayMode = "SAFE";
    finalDisplayGrade = safeGrade;
    finalRank = safeRank;
  } else if (aggressiveRank > MODE_GRADE_RANK.REJECT) {
    finalDisplayMode = "AGGRESSIVE";
    finalDisplayGrade = effectiveAggressiveGrade;
    finalRank = aggressiveRank;
  }

  return {
    finalDisplayMode,
    finalDisplayGrade,
    safeRank,
    aggressiveRank,
    finalRank,
  };
}

function getFinalSelectedLeg(candidate) {
  const finalDisplayMode = String(candidate?.finalDisplayMode || "").trim().toUpperCase();
  const finalDisplayGrade = String(candidate?.finalDisplayGrade || "").trim().toUpperCase();
  const fallbackRecommendation =
    finalDisplayMode && finalDisplayGrade
      ? null
      : getFinalDisplayRecommendation(candidate);
  const resolvedMode = finalDisplayMode || fallbackRecommendation?.finalDisplayMode || "";
  const resolvedGrade = finalDisplayGrade || fallbackRecommendation?.finalDisplayGrade || "";
  if (resolvedGrade === "REJECT") return null;
  if (resolvedMode === "SAFE") return candidate?.safeStrike ?? null;
  if (resolvedMode === "AGGRESSIVE") return candidate?.aggressiveStrike ?? null;
  return null;
}

function getLegPremiumValue(leg) {
  const premium = Number(
    leg?.bid ??
      leg?.premiumUsed ??
      leg?.mid ??
      leg?.premium ??
      leg?.primeUsed
  );
  return Number.isFinite(premium) && premium > 0 ? premium : null;
}

function getLegSpreadPct(leg) {
  return normalizedIbkrSpreadPctPercent(leg?.liquidity?.spreadPct ?? leg?.spreadPct);
}

function getLegYieldPct(leg, candidate) {
  const directYield = Number(leg?.weeklyYield ?? leg?.periodYield ?? NaN);
  if (Number.isFinite(directYield) && directYield > 0) return directYield;
  const strike = Number(leg?.strike ?? NaN);
  const premium = getLegPremiumValue(leg);
  if (Number.isFinite(strike) && strike > 0 && Number.isFinite(premium) && premium > 0) {
    return (premium / strike) * 100;
  }
  const fallbackYield = Number(candidate?.weeklyReturn ?? NaN);
  return Number.isFinite(fallbackYield) && fallbackYield > 0 ? fallbackYield : null;
}

function getLegDistancePct(leg) {
  const distance = Number(leg?.distancePct ?? NaN);
  return Number.isFinite(distance) ? distance : null;
}

function getLegPopPct(leg) {
  const rawPop = Number(leg?.popProfitEstimated ?? leg?.popEstimate ?? NaN);
  if (!Number.isFinite(rawPop)) return null;
  return rawPop <= 1 ? rawPop * 100 : rawPop;
}

function clamp01(value) {
  if (!Number.isFinite(Number(value))) return 0;
  return Math.max(0, Math.min(1, Number(value)));
}

function normalizeScoreUnit(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  if (numeric >= 0 && numeric <= 1) return numeric;
  return clamp01(numeric / 100);
}

function getCapitalComboTierScore(meta) {
  const tier = String(meta?.qualityTier || "").trim();
  if (tier === "Core Quality") return 1;
  if (tier === "Cyclique") return 0.82;
  if (tier === "Spéculatif favori") return 0.62;
  if (tier === "Thématique risqué") return 0.45;
  if (tier === "Inconnu à valider") return 0.2;
  if (tier === "Crypto bloqué") return 0;
  return 0.5;
}

function normalizeComboYieldScore(yieldPct, mode) {
  const value = Number(yieldPct);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const min = Number(mode?.minWeeklyYield ?? 0);
  const max = Number(mode?.maxWeeklyYield ?? NaN);
  const hardCap = Number(mode?.yieldHardCap ?? NaN);

  if (Number.isFinite(max) && max > min) {
    if (value < min) return clamp01((value / min) * 0.55);
    if (value <= max) return 0.7 + 0.3 * clamp01((value - min) / (max - min));
    const ceiling = Number.isFinite(hardCap) && hardCap > max ? hardCap : max + (max - min);
    const decay = clamp01((value - max) / Math.max(ceiling - max, 0.01));
    return Math.max(0.2, 1 - 0.6 * decay);
  }

  if (value < min) return clamp01((value / min) * 0.65);
  const softBand = Number.isFinite(hardCap) && hardCap > min ? hardCap - min : Math.max(min * 0.8, 0.5);
  const climb = clamp01((value - min) / Math.max(softBand, 0.01));
  const overshoot = Number.isFinite(hardCap) && value > hardCap
    ? clamp01((value - hardCap) / Math.max(hardCap, 0.5))
    : 0;
  return Math.max(0.25, Math.min(1, 0.72 + 0.28 * climb - 0.35 * overshoot));
}

function normalizeComboDistanceScore(distancePct, mode) {
  const value = Number(distancePct);
  if (!Number.isFinite(value)) return 0.35;
  const safeDistance = Math.abs(Math.min(value, 0));
  const target = Number(mode?.distanceTargetAbs ?? 6);
  return clamp01(safeDistance / Math.max(target, 0.1));
}

function normalizeComboSpreadScore(spreadPct, mode) {
  const value = Number(spreadPct);
  const max = Number(mode?.maxSpreadPct ?? NaN);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return clamp01((max - value) / max);
}

function buildCapitalComboPoolStats(candidates) {
  const sectorCounts = new Map();
  const themeCounts = new Map();
  for (const candidate of candidates || []) {
    const sector = String(candidate?._tickerMeta?.sector || "unknown").trim().toLowerCase();
    const theme = String(candidate?._qualityOverlay?.concentrationTheme || "none").trim().toLowerCase();
    sectorCounts.set(sector, (sectorCounts.get(sector) ?? 0) + 1);
    themeCounts.set(theme, (themeCounts.get(theme) ?? 0) + 1);
  }
  return { sectorCounts, themeCounts };
}

function buildCapitalComboScoreBreakdown(candidate, mode, usableCapital, poolStats) {
  const overlay = candidate?._qualityOverlay ?? {};
  const meta = candidate?._tickerMeta ?? {};
  const sectorKey = String(meta?.sector || "unknown").trim().toLowerCase();
  const themeKey = String(overlay?.concentrationTheme || "none").trim().toLowerCase();
  const sectorCount = poolStats?.sectorCounts?.get(sectorKey) ?? 1;
  const themeCount = poolStats?.themeCounts?.get(themeKey) ?? 1;
  const qualityKnownBonus = meta?.name ? 1 : 0;
  const sectorKnownBonus = meta?.sector ? 1 : 0;

  const gradeNorm = candidate.finalDisplayGrade === "A" ? 1 : candidate.finalDisplayGrade === "B" ? 0.72 : 0;
  const yieldNorm = normalizeComboYieldScore(candidate.selectedYieldPct, mode);
  const spreadNorm = normalizeComboSpreadScore(candidate.selectedSpreadPct, mode);
  const distanceNorm = normalizeComboDistanceScore(candidate.selectedDistancePct, mode);
  const qualityNorm = clamp01(
    0.35 * (overlay?.qualityScore ?? 0.5) +
    0.2 * normalizeScoreUnit(candidate.proFinalScore) +
    0.15 * normalizeScoreUnit(candidate.proExecutionScore) +
    0.1 * normalizeScoreUnit(candidate.proDistanceScore) +
    0.1 * getCapitalComboTierScore(meta) +
    0.05 * qualityKnownBonus +
    0.05 * sectorKnownBonus
  );
  const riskPenaltyNorm = clamp01(
    (overlay?.speculativePenalty ?? 0) +
    (overlay?.premiumTrapPenalty ?? 0) +
    (overlay?.earningsPenalty ?? 0) +
    (overlay?.liquidityPenalty ?? 0)
  );
  const capitalFitNorm =
    usableCapital > 0 && candidate.capitalPerContract > 0
      ? clamp01(1 - candidate.capitalPerContract / usableCapital)
      : 0;
  const diversificationPenaltyNorm = clamp01(
    0.55 * clamp01(Math.max(themeCount - 1, 0) / 3) +
    0.45 * clamp01(Math.max(sectorCount - 1, 0) / 5)
  );

  const weighted = {
    grade: mode.weights.grade * gradeNorm,
    yield: mode.weights.yield * yieldNorm,
    spread: mode.weights.spread * spreadNorm,
    distance: mode.weights.distance * distanceNorm,
    quality: mode.weights.quality * qualityNorm,
    riskPenalty: mode.weights.riskPenalty * riskPenaltyNorm,
    capitalFit: mode.weights.capitalFit * capitalFitNorm,
    diversificationPenalty: mode.weights.diversificationPenalty * diversificationPenaltyNorm,
  };
  const totalScore = Math.max(
    0,
    Math.round(
      weighted.grade +
        weighted.yield +
        weighted.spread +
        weighted.distance +
        weighted.quality +
        weighted.capitalFit -
        weighted.riskPenalty -
        weighted.diversificationPenalty
    )
  );

  const factors = [
    { key: "grade", value: weighted.grade },
    { key: "yield", value: weighted.yield },
    { key: "spread", value: weighted.spread },
    { key: "distance", value: weighted.distance },
    { key: "quality", value: weighted.quality },
    { key: "capitalFit", value: weighted.capitalFit },
  ].sort((a, b) => b.value - a.value);

  let selectionReason = "selected: quality and risk-adjusted balance";
  if (factors[0]?.key === "yield" && candidate.finalDisplayGrade === "A") {
    selectionReason = "selected: best yield after A-grade filter";
  } else if (["spread", "distance"].includes(factors[0]?.key)) {
    selectionReason = "selected: superior spread-distance balance";
  } else if (factors[0]?.key === "capitalFit") {
    selectionReason = "selected: best capital efficiency";
  } else if (["quality", "grade"].includes(factors[0]?.key)) {
    selectionReason = "selected: strongest quality profile after strict filters";
  }

  return {
    totalScore,
    summary: [
      `grade +${Math.round(weighted.grade)}`,
      `yield +${Math.round(weighted.yield)}`,
      `spread +${Math.round(weighted.spread)}`,
      `distance +${Math.round(weighted.distance)}`,
      `quality +${Math.round(weighted.quality)}`,
      `risk -${Math.round(weighted.riskPenalty)}`,
      `capital +${Math.round(weighted.capitalFit)}`,
      `diversification -${Math.round(weighted.diversificationPenalty)}`,
    ].join(" • "),
    selectionReason,
    tooltip: [
      `Score ${totalScore}`,
      `Grade ${candidate.finalDisplayGrade}: +${Math.round(weighted.grade)}`,
      `Yield ${Number(candidate.selectedYieldPct ?? 0).toFixed(2)}%: +${Math.round(weighted.yield)}`,
      `Spread ${Number(candidate.selectedSpreadPct ?? 0).toFixed(1)}%: +${Math.round(weighted.spread)}`,
      `Distance ${Number(candidate.selectedDistancePct ?? 0).toFixed(1)}%: +${Math.round(weighted.distance)}`,
      `Quality: +${Math.round(weighted.quality)}`,
      `Risk penalty: -${Math.round(weighted.riskPenalty)}`,
      `Capital fit: +${Math.round(weighted.capitalFit)}`,
      `Diversification penalty: -${Math.round(weighted.diversificationPenalty)}`,
    ].join("\n"),
  };
}

function computeModeRecommendation({
  safeStrike,
  aggressiveStrike,
  lowerBound,
  spot,
  hasUpcomingEarningsBeforeExpiration,
  hasEarningsBeforeExpiration,
  earningsDaysUntil,
}) {
  const safePremium = Number(
    safeStrike?.premiumUsed ?? safeStrike?.bid ?? safeStrike?.mid ?? safeStrike?.premium
  );
  const aggressivePremium = Number(
    aggressiveStrike?.premiumUsed ??
      aggressiveStrike?.bid ??
      aggressiveStrike?.mid ??
      aggressiveStrike?.premium
  );
  const safeSpreadPct = Number(safeStrike?.liquidity?.spreadPct ?? safeStrike?.spreadPct);
  const aggressiveSpreadPct = Number(
    aggressiveStrike?.liquidity?.spreadPct ?? aggressiveStrike?.spreadPct
  );
  const aggressivePop = Number(
    aggressiveStrike?.popProfitEstimated ?? aggressiveStrike?.popEstimate
  );
  const aggressiveStrikePrice = Number(aggressiveStrike?.strike);
  const lb = Number(lowerBound);
  const px = Number(spot);
  const ratio =
    Number.isFinite(aggressivePremium) &&
    Number.isFinite(safePremium) &&
    safePremium > 0
      ? aggressivePremium / safePremium
      : null;

  const earningsRisk =
    hasUpcomingEarningsBeforeExpiration === true ||
    hasEarningsBeforeExpiration === true ||
    (Number.isFinite(Number(earningsDaysUntil)) &&
      Number(earningsDaysUntil) >= 0 &&
      Number(earningsDaysUntil) <= 7);

  const lowerBoundNearMax =
    Number.isFinite(lb) && Number.isFinite(px) && px > 0 ? lb + px * 0.02 : null;
  const lowerBoundOk =
    Number.isFinite(aggressiveStrikePrice) &&
    Number.isFinite(lb) &&
    (aggressiveStrikePrice <= lb ||
      (Number.isFinite(lowerBoundNearMax) && aggressiveStrikePrice <= lowerBoundNearMax));

  const aggressiveDistancePct =
    Number.isFinite(aggressiveStrikePrice) && Number.isFinite(px) && px > 0
      ? ((px - aggressiveStrikePrice) / px) * 100
      : null;
  const tooCloseSpot = Number.isFinite(aggressiveDistancePct) && aggressiveDistancePct < 2;

  let aggressiveOpportunityScore = 0;
  const reasons = [];

  if (Number.isFinite(ratio) && ratio >= 1.5) {
    aggressiveOpportunityScore += 30;
    reasons.push(`prime x${ratio.toFixed(2)}`);
  }
  if (Number.isFinite(ratio) && ratio >= 2.0) aggressiveOpportunityScore += 20;

  if (Number.isFinite(aggressiveSpreadPct) && aggressiveSpreadPct <= 10) {
    aggressiveOpportunityScore += 20;
    reasons.push(`spread ${aggressiveSpreadPct.toFixed(1)}%`);
  } else if (Number.isFinite(aggressiveSpreadPct) && aggressiveSpreadPct <= 15) {
    aggressiveOpportunityScore += 10;
    reasons.push(`spread ${aggressiveSpreadPct.toFixed(1)}%`);
  } else if (Number.isFinite(aggressiveSpreadPct) && aggressiveSpreadPct > 20) {
    aggressiveOpportunityScore -= 30;
  }

  if (Number.isFinite(aggressivePop) && aggressivePop >= 0.7) {
    aggressiveOpportunityScore += 20;
    reasons.push(`POP ${(aggressivePop * 100).toFixed(0)}%`);
  } else if (Number.isFinite(aggressivePop) && aggressivePop >= 0.65) {
    aggressiveOpportunityScore += 10;
    reasons.push(`POP ${(aggressivePop * 100).toFixed(0)}%`);
  }

  if (lowerBoundOk) aggressiveOpportunityScore += 15;
  if (earningsRisk) aggressiveOpportunityScore -= 25;
  if (tooCloseSpot) aggressiveOpportunityScore -= 30;

  const safeScoreBase = Number(
    safeStrike?.popProfitEstimated ?? safeStrike?.popEstimate ?? 0
  );
  let safeScore = 50;
  if (Number.isFinite(safeScoreBase)) safeScore += Math.max(-20, Math.min(20, safeScoreBase * 20));
  if (Number.isFinite(safeSpreadPct) && safeSpreadPct <= 10) safeScore += 10;
  else if (Number.isFinite(safeSpreadPct) && safeSpreadPct > 20) safeScore -= 15;
  if (earningsRisk) safeScore -= 10;
  safeScore = Math.max(0, Math.min(100, safeScore));

  const safeWeeklyYieldPct = Number(safeStrike?.weeklyYield);
  const aggressiveWeeklyYieldPct = Number(aggressiveStrike?.weeklyYield);
  const safePopDecimal = Number(safeStrike?.popProfitEstimated ?? safeStrike?.popEstimate);
  const safeDistancePct = Number(safeStrike?.distancePct);
  const aggressiveDistancePctDisplay = Number(aggressiveStrike?.distancePct);

  const safeGrade = gradeLeg({
    spreadPct: safeSpreadPct,
    weeklyYieldPct: safeWeeklyYieldPct,
    popDecimal: safePopDecimal,
  });
  const aggressiveGrade = earningsRisk
    ? "REJECT"
    : gradeLeg({
        spreadPct: aggressiveSpreadPct,
        weeklyYieldPct: aggressiveWeeklyYieldPct,
        popDecimal: aggressivePop,
      });
  const aggressivePriorityGrade = earningsRisk
    ? null
    : getAggressivePriorityGrade({
        spreadPct: aggressiveSpreadPct,
        weeklyYieldPct: aggressiveWeeklyYieldPct,
        popDecimal: aggressivePop,
        distancePct: aggressiveDistancePctDisplay,
      });

  const effectiveAggressiveGrade = aggressivePriorityGrade ?? aggressiveGrade;
  const safeRank = getModeGradeRank("SAFE", safeGrade);
  const aggressiveRank = getModeGradeRank("AGGRESSIVE", effectiveAggressiveGrade);

  let recommendedMode = "REJECT";
  let recommendedGrade = "REJECT";
  if (safeRank === MODE_GRADE_RANK.REJECT && aggressiveRank === MODE_GRADE_RANK.REJECT) {
    recommendedMode = "REJECT";
    recommendedGrade = "REJECT";
  } else if (aggressiveRank > safeRank) {
    recommendedMode = "AGGRESSIVE";
    recommendedGrade = effectiveAggressiveGrade;
  } else if (safeRank > MODE_GRADE_RANK.REJECT) {
    recommendedMode = "SAFE";
    recommendedGrade = safeGrade;
  } else if (aggressiveRank > MODE_GRADE_RANK.REJECT) {
    recommendedMode = "AGGRESSIVE";
    recommendedGrade = effectiveAggressiveGrade;
  }
  const normalizedRecommendation = getFinalDisplayRecommendation({
    safeStrike,
    aggressiveStrike,
    safeGrade,
    aggressiveGrade,
    recommendedMode,
    recommendedGrade,
    recommendationDiagnostics: {
      safeYieldPct: Number.isFinite(safeWeeklyYieldPct) ? Number(safeWeeklyYieldPct) : null,
      aggressiveYieldPct: Number.isFinite(aggressiveWeeklyYieldPct) ? Number(aggressiveWeeklyYieldPct) : null,
      safeSpreadPct: Number.isFinite(safeSpreadPct) ? Number(safeSpreadPct) : null,
      aggressiveSpreadPctDisplay: Number.isFinite(aggressiveSpreadPct) ? Number(aggressiveSpreadPct) : null,
      safeDistancePct: Number.isFinite(safeDistancePct) ? Number(safeDistancePct) : null,
      aggressiveDistancePctDisplay: Number.isFinite(aggressiveDistancePctDisplay)
        ? Number(aggressiveDistancePctDisplay)
        : null,
      aggressivePop: Number.isFinite(aggressivePop) ? Number(aggressivePop) : null,
      safeRank,
      aggressiveRank,
    },
  });
  recommendedMode = normalizedRecommendation.finalDisplayMode;
  recommendedGrade = normalizedRecommendation.finalDisplayGrade;
  const finalRank = normalizedRecommendation.finalRank ?? getModeGradeRank(recommendedMode, recommendedGrade);

  const recommendedReason = (() => {
    if (recommendedMode === "REJECT") return "Rejeté — spread ou liquidité insuffisant sur les deux jambes";
    const isAggr = recommendedMode === "AGGRESSIVE";
    const legYld = isAggr ? aggressiveWeeklyYieldPct : safeWeeklyYieldPct;
    const legSp = isAggr ? aggressiveSpreadPct : safeSpreadPct;
    const legPop = isAggr ? aggressivePop : safePopDecimal;
    const yldStr = Number.isFinite(legYld) && legYld > 0 ? `${legYld.toFixed(2)}%` : "—";
    const spStr = Number.isFinite(legSp) ? `${legSp.toFixed(1)}%` : "—";
    const popStr = Number.isFinite(legPop) && legPop > 0 ? `${(legPop * 100).toFixed(1)}%` : null;
    if (recommendedGrade === "WATCH") {
      return `${isAggr ? "Agressif" : "Safe"} à surveiller : rendement ${yldStr}, spread ${spStr}${popStr ? `, POP ${popStr}` : ""}`;
    }
    if (isAggr) {
      return `Agressif meilleur : rendement ${yldStr}, spread ${spStr}${popStr ? `, POP ${popStr}` : ""}`;
    }
    return earningsRisk ? "SAFE — risque earnings" : "SAFE — meilleur compromis risque/liquidité";
  })();

  return {
    safeScore: Math.round(safeScore),
    aggressiveOpportunityScore: Math.round(aggressiveOpportunityScore),
    safeGrade,
    aggressiveGrade,
    recommendedMode,
    recommendedGrade,
    recommendedReason,
    recommendationDiagnostics: {
      premiumRatio: Number.isFinite(ratio) ? Number(ratio.toFixed(4)) : null,
      aggressiveSpreadPct: Number.isFinite(aggressiveSpreadPct) ? Number(aggressiveSpreadPct.toFixed(4)) : null,
      aggressivePop: Number.isFinite(aggressivePop) ? Number(aggressivePop.toFixed(6)) : null,
      lowerBoundOk,
      earningsRisk,
      aggressiveTooCloseSpot: tooCloseSpot,
      aggressiveDistancePct:
        Number.isFinite(aggressiveDistancePct) ? Number(aggressiveDistancePct.toFixed(4)) : null,
      safeYieldPct: Number.isFinite(safeWeeklyYieldPct) ? Number(safeWeeklyYieldPct.toFixed(4)) : null,
      aggressiveYieldPct: Number.isFinite(aggressiveWeeklyYieldPct)
        ? Number(aggressiveWeeklyYieldPct.toFixed(4))
        : null,
      safeSpreadPct: Number.isFinite(safeSpreadPct) ? Number(safeSpreadPct.toFixed(4)) : null,
      aggressiveSpreadPctDisplay: Number.isFinite(aggressiveSpreadPct) ? Number(aggressiveSpreadPct.toFixed(4)) : null,
      safeDistancePct: Number.isFinite(safeDistancePct) ? Number(safeDistancePct.toFixed(4)) : null,
      aggressiveDistancePctDisplay: Number.isFinite(aggressiveDistancePctDisplay)
        ? Number(aggressiveDistancePctDisplay.toFixed(4))
        : null,
      safeGrade,
      aggressiveGrade,
      safeRank,
      aggressiveRank,
      finalRank,
      aggressivePriorityGrade,
      finalDisplayMode: recommendedMode,
      finalDisplayGrade: recommendedGrade,
      recommendedMode,
      recommendedGrade,
      reasons,
    },
  };
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function computeFinalTradeQualityScore({
  symbol,
  safeStrike,
  aggressiveStrike,
  lowerBound,
  spot,
  dteDays,
  minPremium,
  recommendedMode,
  aggressiveOpportunityScore,
  hasUpcomingEarningsBeforeExpiration,
  hasEarningsBeforeExpiration,
  earningsDaysUntil,
  eliteScore,
}) {
  const notes = [];
  const safeSpreadPct = getSafeSpreadPct({ safeStrike });
  let spreadScore = 0;
  if (safeSpreadPct == null) {
    spreadScore = -5;
    notes.push("spread_safe_inconnu");
  } else if (safeSpreadPct <= 7) spreadScore = 30;
  else if (safeSpreadPct <= 10) spreadScore = 24;
  else if (safeSpreadPct <= 15) spreadScore = 12;
  else if (safeSpreadPct <= 20) spreadScore = 3;
  else spreadScore = -15;

  const earningsRisk =
    hasUpcomingEarningsBeforeExpiration === true ||
    hasEarningsBeforeExpiration === true ||
    (Number.isFinite(Number(earningsDaysUntil)) &&
      Number(earningsDaysUntil) >= 0 &&
      Number(earningsDaysUntil) <= 7);
  let earningsScore = 8;
  if (earningsRisk) earningsScore = -20;
  else earningsScore = 20;

  const safePopRaw = Number(safeStrike?.popProfitEstimated ?? safeStrike?.popEstimate);
  const safePopPct = Number.isFinite(safePopRaw) ? safePopRaw * 100 : null;
  let popScore = 0;
  if (safePopPct == null) {
    popScore = 0;
    notes.push("pop_safe_inconnu");
  } else if (safePopPct >= 80) popScore = 15;
  else if (safePopPct >= 75) popScore = 12;
  else if (safePopPct >= 70) popScore = 8;
  else if (safePopPct >= 65) popScore = 4;
  else popScore = -5;

  const safePremium = Number(
    safeStrike?.premiumUsed ?? safeStrike?.primeUsed ?? safeStrike?.bid ?? safeStrike?.mid
  );
  const targetPremium = Number(minPremium);
  let premiumScore = 0;
  if (Number.isFinite(safePremium) && Number.isFinite(targetPremium) && targetPremium > 0) {
    if (safePremium >= targetPremium) premiumScore = 10;
    else if (safePremium >= targetPremium * 0.75) premiumScore = 5;
    else premiumScore = -5;
  } else {
    premiumScore = -2;
    notes.push("premium_safe_inconnu");
  }

  const safeStrikePrice = Number(safeStrike?.strike);
  const px = Number(spot);
  const lb = Number(lowerBound);
  const safeDistancePct =
    Number.isFinite(safeStrikePrice) && Number.isFinite(px) && px > 0
      ? ((px - safeStrikePrice) / px) * 100
      : null;
  const safeBelowLowerBound =
    Number.isFinite(safeStrikePrice) && Number.isFinite(lb) ? safeStrikePrice <= lb : null;
  let distanceScore = 0;
  if (safeDistancePct == null || safeBelowLowerBound == null) {
    distanceScore = 0;
    notes.push("distance_lowerbound_incomplet");
  } else if (safeDistancePct >= 4 && safeBelowLowerBound) distanceScore = 10;
  else if (safeDistancePct >= 2) distanceScore = 5;
  else distanceScore = -10;

  const dte = Number(dteDays);
  let dteScore = 0;
  if (!Number.isFinite(dte)) {
    dteScore = 0;
    notes.push("dte_inconnu");
  } else if (dte >= 7 && dte <= 21) dteScore = 10;
  else if (dte >= 22 && dte <= 35) dteScore = 6;
  else if (dte < 7) dteScore = -8;
  else dteScore = 2;

  const elite = Number(eliteScore);
  const eliteScoreBonus = Number.isFinite(elite)
    ? clampNumber((elite / 100) * 5, 0, 5)
    : 0;

  const aggressiveSpreadPct = Number(
    aggressiveStrike?.liquidity?.spreadPct ?? aggressiveStrike?.spreadPct
  );
  const aggrOpp = Number(aggressiveOpportunityScore);
  let aggressiveBonus = 0;
  const aggressiveAllowed =
    !earningsRisk &&
    (!Number.isFinite(aggressiveSpreadPct) || aggressiveSpreadPct <= 15) &&
    (recommendedMode === "AGGRESSIVE" || (Number.isFinite(aggrOpp) && aggrOpp >= 50));
  if (aggressiveAllowed) {
    if (recommendedMode === "AGGRESSIVE" || aggrOpp >= 70) aggressiveBonus = 10;
    else aggressiveBonus = 5;
  }

  const rawTotal =
    spreadScore +
    earningsScore +
    popScore +
    premiumScore +
    distanceScore +
    dteScore +
    eliteScoreBonus +
    aggressiveBonus;
  const total = clampNumber(Math.round(rawTotal * 1000) / 1000, 0, 110);

  return {
    finalTradeQualityScore: total,
    finalTradeQualityBreakdown: {
      spreadScore,
      earningsScore,
      popScore,
      premiumScore,
      distanceScore,
      dteScore,
      eliteScoreBonus,
      aggressiveBonus,
      total,
      notes,
    },
    logPayload: {
      symbol,
      finalTradeQualityScore: total,
      finalTradeQualityBreakdown: {
        spreadScore,
        earningsScore,
        popScore,
        premiumScore,
        distanceScore,
        dteScore,
        eliteScoreBonus,
        aggressiveBonus,
        total,
        notes,
      },
    },
  };
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
  if (isValidLevel(item.support)) return true;
  if (isValidLevel(item.resistance)) return true;
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

function formatScanSessionId(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
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

function computeDteAtScan(scanTimestamp, expirationYmd) {
  const exp = normalizeExpirationYmd(expirationYmd);
  if (!exp) return null;
  const scanIso = scanTimestamp == null ? new Date().toISOString() : String(scanTimestamp);
  const scanDate = new Date(scanIso);
  if (Number.isNaN(scanDate.getTime())) return null;
  const scanDayUtc = Date.UTC(scanDate.getUTCFullYear(), scanDate.getUTCMonth(), scanDate.getUTCDate());
  const [y, m, d] = exp.split("-").map(Number);
  const expDayUtc = Date.UTC(y, m - 1, d);
  if (!Number.isFinite(scanDayUtc) || !Number.isFinite(expDayUtc)) return null;
  return Math.round((expDayUtc - scanDayUtc) / 86400000);
}

function resolveMergedDteDays({ ibkrDte, yahooDte, expirationYmd, todayYmd = ymdTodayLocal() }) {
  const ibkr = Number(ibkrDte);
  if (Number.isFinite(ibkr) && ibkr >= 0) return Math.max(0, Math.ceil(ibkr));

  const exp = normalizeExpirationYmd(expirationYmd);
  const fallbackDiff = exp ? daysBetweenYmd(todayYmd, exp) : null;
  if (Number.isFinite(fallbackDiff)) return Math.max(0, Math.ceil(fallbackDiff));

  const yahoo = Number(yahooDte);
  if (Number.isFinite(yahoo) && yahoo >= 0) return Math.max(0, Math.ceil(yahoo));

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

function createEmptyYahooDiagnostics() {
  return {
    scanned: 0,
    kept: 0,
    returned: 0,
    rejectedTotal: 0,
    rejectionReasonCounts: {},
    stageRejectCounts: {},
    rejectedSample: [],
    savedAt: null,
  };
}

function normalizeCountMap(countsLike) {
  const counts = {};
  if (!countsLike || typeof countsLike !== "object") return counts;
  for (const [rawKey, rawValue] of Object.entries(countsLike)) {
    const key = String(rawKey || "").trim();
    const n = Number(rawValue);
    if (!key || !Number.isFinite(n) || n <= 0) continue;
    counts[key] = Math.round(n);
  }
  return counts;
}

function topCountEntries(countsLike, limit = 10) {
  return Object.entries(normalizeCountMap(countsLike))
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function normalizeYahooDiagnosticsForState(diagnostics, fallbackMeta = {}) {
  const base = createEmptyYahooDiagnostics();
  const scanned = Number.isFinite(Number(diagnostics?.scanned))
    ? Number(diagnostics.scanned)
    : Number(fallbackMeta?.scanned || 0);
  const kept = Number.isFinite(Number(diagnostics?.kept))
    ? Number(diagnostics.kept)
    : Number(fallbackMeta?.kept || 0);
  const returned = Number.isFinite(Number(diagnostics?.returned))
    ? Number(diagnostics.returned)
    : Number(fallbackMeta?.returned || 0);
  const rejectedTotal = Number.isFinite(Number(diagnostics?.rejectedTotal))
    ? Number(diagnostics.rejectedTotal)
    : Math.max(0, scanned - kept);
  const rejectedSample = Array.isArray(diagnostics?.rejectedSample)
    ? diagnostics.rejectedSample
        .map((row) => ({
          symbol: String(row?.symbol || "").trim().toUpperCase(),
          reason: String(row?.reason || "").trim() || "unknown",
        }))
        .filter((row) => row.symbol)
        .slice(0, 20)
    : [];
  return {
    ...base,
    scanned: Math.max(0, scanned),
    kept: Math.max(0, kept),
    returned: Math.max(0, returned),
    rejectedTotal: Math.max(0, rejectedTotal),
    rejectionReasonCounts: normalizeCountMap(diagnostics?.rejectionReasonCounts),
    stageRejectCounts: normalizeCountMap(diagnostics?.stageRejectCounts),
    rejectedSample,
    savedAt:
      diagnostics?.savedAt && !Number.isNaN(new Date(diagnostics.savedAt).getTime())
        ? diagnostics.savedAt
        : null,
  };
}

function buildYahooDiagnosticsFromScanPayload(payload, fallbackMeta = {}) {
  const rejectedRows = Array.isArray(payload?.rejected) ? payload.rejected : [];
  return normalizeYahooDiagnosticsForState(
    {
      scanned: payload?.scanned,
      kept: payload?.kept,
      returned: payload?.returned,
      rejectedTotal: rejectedRows.length,
      rejectionReasonCounts: payload?.rejectionReasonCounts,
      stageRejectCounts: payload?.stageRejectCounts,
      rejectedSample: rejectedRows.slice(0, 20).map((row) => ({
        symbol: row?.symbol,
        reason: row?.reason ?? row?.status ?? "unknown",
      })),
      savedAt: new Date().toISOString(),
    },
    fallbackMeta
  );
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

function countOwnFields(value) {
  if (!value || typeof value !== "object") return 0;
  return Object.keys(value).length;
}

function missingOwnFields(source, target) {
  if (!source || typeof source !== "object") return [];
  const targetKeys = target && typeof target === "object" ? new Set(Object.keys(target)) : new Set();
  return Object.keys(source).filter((key) => !targetKeys.has(key));
}

function comparableValue(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return `array:${value.length}`;
  return `object:${Object.keys(value).length}`;
}

function changedOwnFields(source, target) {
  if (!source || typeof source !== "object" || !target || typeof target !== "object") return [];
  return Object.keys(source).filter((key) => {
    if (!(key in target)) return false;
    return comparableValue(source[key]) !== comparableValue(target[key]);
  });
}

function toDashboardCandidate_LEGACY(item, index, selectedExpiration) {
  const source = item && typeof item === "object" ? item : {};
  const { diagnosticsV12: _diagnosticsV12, ...raw } = source;
  const ticker = raw.ticker ?? raw.symbol ?? "";

  return {
    ...raw,
    rank: index + 1,
    ticker,
    name: raw.name ?? ticker,
    targetExpiration: raw.targetExpiration ?? selectedExpiration ?? raw.expiration ?? null,
    price: raw.price ?? raw.currentPrice ?? null,
  };
}

function logCandidateCompare(item, v12, legacy) {
  if (!DEBUG_COMPARE) return;

  console.log("CANDIDATE_COMPARE", {
    symbol: item?.symbol ?? item?.ticker ?? v12?.ticker ?? legacy?.ticker ?? null,
    v12FieldCount: countOwnFields(v12),
    legacyFieldCount: countOwnFields(legacy),
    legacyMissingInV12: missingOwnFields(legacy, v12),
    v12MissingInLegacy: missingOwnFields(v12, legacy),
    changedFields: changedOwnFields(legacy, v12),
    scoreDiff: {
      legacyQualityScore: legacy?.qualityScore ?? null,
      v12QualityScore: v12?.qualityScore ?? null,
      legacyFinalScore: legacy?.finalScore ?? null,
      v12ProFinalScore: v12?.proFinalScore ?? null,
    },
    strikeDiff: {
      legacySafeStrike: legacy?.safeStrike?.strike ?? null,
      v12SafeStrike: v12?.safeStrike?.strike ?? null,
      legacyAggressiveStrike: legacy?.aggressiveStrike?.strike ?? legacy?.maxPremiumStrike?.strike ?? null,
      v12AggressiveStrike: v12?.aggressiveStrike?.strike ?? null,
    },
    v12,
    legacy,
  });
}

function toDashboardCandidate(item, index, selectedExpiration) {
  const v12 = toDashboardCandidate_V12(item, index, selectedExpiration);
  const legacy = toDashboardCandidate_LEGACY(item, index, selectedExpiration);
  logCandidateCompare(item, v12, legacy);
  return v12;
}

function toDashboardCandidate_V12(item, index, selectedExpiration) {
  const activeEarningsMode = item?.earningsMode === true;
  const safe = item?.ibkrSafeStrike ?? item?.safeStrike ?? null;
  const aggressive = item?.ibkrAggressiveStrike ?? item?.aggressiveStrike ?? item?.maxPremiumStrike ?? null;
  const primaryStrike = safe || aggressive;
  const impliedVolatility = safe?.impliedVolatility ?? aggressive?.impliedVolatility ?? null;
  const preferredExpectedMove = item?.ibkrExpectedMove ?? item?.expectedMove ?? null;
  const safeBidPreferred = item?.ibkrSafeBid ?? safe?.bid ?? null;
  const aggressiveBidPreferred = item?.ibkrAggressiveBid ?? aggressive?.bid ?? null;
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
  const mapStrikeForDashboard = (strike, distancePct, label, preferredBid) => {
    if (!strike) return null;
    const premiumBase =
      strike?.premium ??
      strike?.mid ??
      strike?.primeUsed ??
      strike?.premiumUsed ??
      strike?.bid ??
      null;
    const bid = preferredBid ?? strike?.bid ?? null;
    const ask = strike?.ask ?? null;
    return {
      strike: strike.strike,
      mid: premiumBase,
      bid,
      ask,
      premiumUsed: strike?.premiumUsed ?? strike?.primeUsed ?? bid ?? premiumBase ?? null,
      premiumLabel: strike?.premiumLabel ?? (strike?.primeUsed != null ? "Prime utilisée" : "BID utilisée"),
      popEstimate: strike.popEstimate ?? null,
      popProfitEstimated: strike.popProfitEstimated ?? null,
      popOtmEstimated: strike.popOtmEstimated ?? null,
      popSource: strike.popSource ?? null,
      periodYield: (strike.periodYield ?? strike.weeklyYield ?? 0) * 100,
      weeklyYield: (strike.weeklyYield ?? 0) * 100,
      weeklyNormalizedYield:
        (strike.weeklyNormalizedYield ?? strike.weeklyYield ?? 0) * 100,
      annualizedYield: (strike.annualizedYield ?? 0) * 100,
      dteDays: Number.isFinite(Number(item.dteDays)) ? Number(item.dteDays) : null,
      distancePct,
      label,
      liquidity: strike.liquidity ?? null,
    };
  };
  const safeStrikeMapped = mapStrikeForDashboard(
    safe,
    safeDistance,
    "prime la plus proche de la cible",
    safeBidPreferred
  );
  const aggressiveStrikeMapped = mapStrikeForDashboard(
    aggressive,
    aggressiveDistance,
    "directement sous borne basse",
    aggressiveBidPreferred
  );
  const modeRecommendation = computeModeRecommendation({
    safeStrike: safeStrikeMapped,
    aggressiveStrike: aggressiveStrikeMapped,
    lowerBound: item.lowerBound ?? null,
    spot: item.currentPrice ?? null,
    hasUpcomingEarningsBeforeExpiration: item.hasUpcomingEarningsBeforeExpiration ?? false,
    hasEarningsBeforeExpiration: item.hasEarningsBeforeExpiration ?? false,
    earningsDaysUntil,
  });
  const finalDisplayRecommendation = getFinalDisplayRecommendation({
    safeStrike: safeStrikeMapped,
    aggressiveStrike: aggressiveStrikeMapped,
    safeGrade: modeRecommendation.safeGrade,
    aggressiveGrade: modeRecommendation.aggressiveGrade,
    recommendedMode: modeRecommendation.recommendedMode,
    recommendedGrade: modeRecommendation.recommendedGrade,
    recommendationDiagnostics: modeRecommendation.recommendationDiagnostics,
  });

  return {
    ...item,
    rank: index + 1,
    ticker: item.symbol,
    name: item.symbol,
    setup: activeEarningsMode
      ? `Mode earnings — expiration ${selectedExpiration}`
      : `PUT scanner — expiration ${selectedExpiration}`,
    targetExpiration: selectedExpiration,
    price: item.currentPrice ?? 0,
    expectedMove: preferredExpectedMove,
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
    dteDays: Number.isFinite(Number(item.dteDays)) ? Number(item.dteDays) : null,
    minPremium: item.targetPremium ?? minPremiumForSpot(item.currentPrice ?? 0),
    targetWeeks: item.targetWeeks ?? 1,
    safeStrike: safeStrikeMapped,
    aggressiveStrike: aggressiveStrikeMapped,
    safeBid: safeBidPreferred,
    aggressiveBid: aggressiveBidPreferred,
    safeScore: modeRecommendation.safeScore,
    aggressiveOpportunityScore: modeRecommendation.aggressiveOpportunityScore,
    safeGrade: modeRecommendation.safeGrade,
    aggressiveGrade: modeRecommendation.aggressiveGrade,
    safeRank: finalDisplayRecommendation.safeRank,
    aggressiveRank: finalDisplayRecommendation.aggressiveRank,
    finalRank: finalDisplayRecommendation.finalRank,
    recommendedMode: modeRecommendation.recommendedMode,
    recommendedGrade: modeRecommendation.recommendedGrade,
    finalDisplayMode: finalDisplayRecommendation.finalDisplayMode,
    finalDisplayGrade: finalDisplayRecommendation.finalDisplayGrade,
    recommendedReason: modeRecommendation.recommendedReason,
    recommendationDiagnostics: modeRecommendation.recommendationDiagnostics,
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
    diagnosticsV12:
      item?.diagnosticsV12 && typeof item.diagnosticsV12 === "object"
        ? { ...item.diagnosticsV12 }
        : null,
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
    supportWide: item.supportResistance?.supportWide ?? item.supportResistance?.support ?? null,
    supportNear: item.supportResistance?.supportNear ?? null,
    potentialSupportFromBrokenResistance:
      item.supportResistance?.potentialSupportFromBrokenResistance ?? null,
    resistanceAboveSpot: item.supportResistance?.resistanceAboveSpot ?? null,
    resistanceCurrent:
      item.supportResistance?.resistanceCurrent ?? item.supportResistance?.resistance ?? null,
    resistanceStatus: item.supportResistance?.resistanceStatus ?? "unavailable",
    supportResistanceMethod: item.supportResistance?.supportResistanceMethod ?? null,
    supportResistance: item.supportResistance ?? null,
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

// ─── Ticker Quality Overlay ───────────────────────────────────────────────────
// Local computation only — no fetch, no scanner impact.

const QUALITY_CRYPTO_MINER_TICKERS = new Set([
  "RIOT", "CIFR", "WULF", "MARA", "CLSK", "HUT", "BITF", "IREN", "BTBT",
]);

const QUALITY_HIGH_BETA_TICKERS = new Map([
  ["APLD", 0.25], ["OKLO", 0.25], ["IONQ", 0.20], ["SOUN", 0.20],
  ["RGTI", 0.25], ["RKLB", 0.20], ["HOOD", 0.15], ["AFRM", 0.15],
  ["PLTR", 0.10],
]);

function normalizeYield(yieldPct) {
  return Math.min(Math.max(yieldPct / 3, 0), 1);
}

function normalizePop(pop) {
  if (pop == null) return 0.75;
  const n = Number(pop);
  if (!Number.isFinite(n)) return 0.75;
  return n > 1 ? n / 100 : n;
}

function computeTickerQualityOverlay(candidate) {
  const ticker = String(candidate?.ticker ?? "").toUpperCase().trim();
  const spreadPct = candidate?.spreadPct ?? null;
  const earningsDaysUntil = candidate?.earningsDaysUntil ?? null;
  const hasEarningsBeforeExpiration =
    candidate?.hasEarningsBeforeExpiration ??
    candidate?.hasUpcomingEarningsBeforeExpiration ??
    false;
  const weeklyReturn = candidate?.weeklyReturn ?? 0;
  const popEstimate = candidate?._popForCombo ?? null;

  let speculativePenalty = 0;
  let liquidityPenalty = 0;
  let earningsPenalty = 0;
  let premiumTrapPenalty = 0;
  let concentrationTheme = null;
  const qualityWarnings = [];

  if (QUALITY_CRYPTO_MINER_TICKERS.has(ticker)) {
    concentrationTheme = "crypto_miner";
    speculativePenalty += 0.25;
    qualityWarnings.push("Crypto miner");
  }

  const highBetaPenalty = QUALITY_HIGH_BETA_TICKERS.get(ticker);
  if (highBetaPenalty != null) {
    if (concentrationTheme == null) concentrationTheme = "high_beta_growth";
    speculativePenalty += highBetaPenalty;
    qualityWarnings.push("High beta growth");
  }

  if (spreadPct != null) {
    if (spreadPct > 35) {
      liquidityPenalty += 0.35;
      qualityWarnings.push("Spread très élevé (>35%)");
    } else if (spreadPct > 20) {
      liquidityPenalty += 0.25;
      qualityWarnings.push("Spread élevé (>20%)");
    }
  }

  if (hasEarningsBeforeExpiration || (earningsDaysUntil != null && earningsDaysUntil <= 7)) {
    earningsPenalty += 0.25;
    qualityWarnings.push("Earnings risk");
  }

  if (weeklyReturn > 2.0) {
    premiumTrapPenalty += 0.20;
    qualityWarnings.push("Prime élevée (>2%)");
  }
  if (weeklyReturn > 1.5 && popEstimate != null && popEstimate < 80) {
    premiumTrapPenalty += 0.30;
    qualityWarnings.push("Premium trap");
  }

  if (popEstimate != null) {
    if (popEstimate < 75) {
      speculativePenalty += 0.20;
      qualityWarnings.push("POP très faible (<75%)");
    } else if (popEstimate < 80) {
      speculativePenalty += 0.20;
      qualityWarnings.push("POP faible (<80%)");
    }
  }

  const rawScore = 1.0 - speculativePenalty - liquidityPenalty - earningsPenalty - premiumTrapPenalty;
  const qualityScore = Math.max(0, Math.min(1, rawScore));

  let qualityTier;
  if (qualityScore >= 0.80) qualityTier = "high";
  else if (qualityScore >= 0.60) qualityTier = "medium";
  else if (qualityScore >= 0.40) qualityTier = "speculative";
  else qualityTier = "avoid";

  return {
    qualityTier,
    qualityScore,
    speculativePenalty,
    liquidityPenalty,
    earningsPenalty,
    premiumTrapPenalty,
    concentrationTheme,
    qualityWarnings,
  };
}

function buildCapitalComboCandidate(candidate, usableCapital) {
  const ticker = String(candidate?.ticker || "").trim().toUpperCase();
  const meta = getTickerDisplayMeta(ticker);
  const recommendation = getFinalDisplayRecommendation(candidate);
  const finalDisplayMode =
    String(candidate?.finalDisplayMode || "").trim().toUpperCase() || recommendation.finalDisplayMode;
  const finalDisplayGrade =
    String(candidate?.finalDisplayGrade || "").trim().toUpperCase() || recommendation.finalDisplayGrade;
  const selectedLeg = getFinalSelectedLeg(candidate);
  const strike = Number(selectedLeg?.strike ?? NaN);
  const premiumUnit = getLegPremiumValue(selectedLeg);
  const spreadPct = getLegSpreadPct(selectedLeg);
  const weeklyReturn = getLegYieldPct(selectedLeg, candidate);
  const distancePct = getLegDistancePct(selectedLeg);
  const popEstimate = getLegPopPct(selectedLeg);
  const capitalPerContract = Number.isFinite(strike) && strike > 0 ? strike * 100 : 0;
  const premiumPerContract =
    Number.isFinite(premiumUnit) && premiumUnit > 0 ? premiumUnit * 100 : 0;
  const gradeScore = finalDisplayGrade === "A" ? 2 : finalDisplayGrade === "B" ? 1 : 0;
  const distanceScore =
    Number.isFinite(distancePct) && distancePct <= 0 ? Math.min(Math.abs(distancePct) / 10, 2) : 0;
  const contractsPenaltyScore = capitalPerContract > 0 ? capitalPerContract / 1000 : 0;
  const isUnknownTicker = isUnknownUnvalidatedTicker(candidate);
  const capitalComboExclusionReasons = [];
  if (isUnknownTicker) capitalComboExclusionReasons.push("rejected: unknown/unvalidated ticker");

  return {
    ...candidate,
    ticker,
    _tickerMeta: meta,
    finalDisplayMode,
    finalDisplayGrade,
    selectedLeg,
    selectedStrikeValue: Number.isFinite(strike) ? strike : null,
    selectedPremiumUnit: premiumUnit,
    selectedSpreadPct: spreadPct,
    selectedYieldPct: weeklyReturn,
    selectedDistancePct: distancePct,
    _popForCombo: popEstimate,
    capitalPerContract,
    premiumPerContract,
    _comboGradeScore: gradeScore,
    _comboDistanceScore: distanceScore,
    _contractsPenaltyScore: contractsPenaltyScore,
    source: candidate?.optionsSource === "IBKR live" ? "IBKR live" : "Yahoo fallback",
    premiumKind:
      selectedLeg?.bid != null
        ? "prime bid"
        : selectedLeg?.premiumUsed != null || selectedLeg?.primeUsed != null
        ? "prime utilisee"
        : "prime fallback",
    spreadPct,
    weeklyReturn,
    _qualityOverlay: computeTickerQualityOverlay({
      ...candidate,
      ticker,
      spreadPct,
      weeklyReturn,
      _popForCombo: popEstimate,
    }),
    _capitalComboExclusionReasons: capitalComboExclusionReasons,
    _isCapitalComboEligible:
      (finalDisplayMode === "SAFE" || finalDisplayMode === "AGGRESSIVE") &&
      (finalDisplayGrade === "A" || finalDisplayGrade === "B") &&
      !!selectedLeg &&
      !(meta.isCryptoBlocked && !meta.isCryptoAllowed) &&
      meta.qualityTier !== "Inconnu à valider" &&
      !isUnknownTicker &&
      Number.isFinite(strike) &&
      strike > 0 &&
      Number.isFinite(premiumUnit) &&
      premiumUnit > 0 &&
      Number.isFinite(spreadPct) &&
      spreadPct <= 35 &&
      Number.isFinite(weeklyReturn) &&
      weeklyReturn > 0 &&
      capitalPerContract > 0 &&
      capitalPerContract <= usableCapital,
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
    .map((c) => buildCapitalComboCandidate(c, usableCapital))
    .filter((c) => c._isCapitalComboEligible);
  const poolStats = buildCapitalComboPoolStats(basePool);

  if (!basePool.length) return [];

  const modeConfigs = [
    {
      id: "aggressive",
      label: "AGGRESSIVE",
      // Identity: high-return quality — pas de junk premium
      tickerCapPct: 0.35,
      positionCapPct: 0.35,
      maxContractsPerTicker: 4,
      minTargetPositions: 3,
      maxThemeCapitalPct: 0.50,
      maxSectorCapitalPct: 0.50,
      maxHighBetaCapitalPct: 0.45,
      minWeeklyYield: 1.0,
      maxWeeklyYield: null,
      minExecutionScore: 0.45,
      maxSpreadPct: 25,
      allowedModes: new Set(["AGGRESSIVE"]),
      allowedGrades: new Set(["A", "B"]),
      minDistancePct: -5,
      distanceTargetAbs: 5,
      yieldHardCap: 2.0,
      weights: {
        grade: 20,
        yield: 24,
        spread: 14,
        distance: 10,
        quality: 12,
        riskPenalty: 10,
        capitalFit: 12,
        diversificationPenalty: 8,
      },
      // Composition limits — enforced in Pass 1 via canAddByComposition
      maxCryptoMinerPositions: 1,
      maxCryptoMinerExceptionCount: 2,      // 2ème autorisé si POP >= 82 + spread <= 20 + quality >= 0.65
      maxCryptoMinerExceptionPopMin: 82,
      maxCryptoMinerExceptionSpreadMax: 20,
      maxCryptoMinerExceptionQualityMin: 0.65,
      maxSpeculativePositions: 2,
      // Score: high-return quality > junk premium
      score: (c) => buildCapitalComboScoreBreakdown(c, modeConfigs[0], usableCapital, poolStats).totalScore,
      filterCandidate: (c) => {
        const ov = c._qualityOverlay;
        if (!ov) return true;
        if (ov.qualityTier === "avoid") return false;
        // Rejeter premium trap fort sauf POP >= 82
        if (ov.premiumTrapPenalty >= 0.40 && (c._popForCombo == null || c._popForCombo < 82)) return false;
        // Rejeter speculative avec spread excessif
        if (ov.qualityTier === "speculative" && c.selectedSpreadPct != null && c.selectedSpreadPct > 20) return false;
        return true;
      },
    },
    {
      id: "balanced",
      label: "BALANCED",
      // Identity: controlled growth — compromis rendement / POP / qualité
      tickerCapPct: 0.32,
      positionCapPct: 0.32,
      maxContractsPerTicker: 3,
      minTargetPositions: 3,
      maxThemeCapitalPct: 0.45,
      maxSectorCapitalPct: 0.45,
      maxHighBetaCapitalPct: 0.40,
      minWeeklyYield: 0.75,
      maxWeeklyYield: 1.0,
      minExecutionScore: 0,
      maxSpreadPct: 20,
      allowedModes: new Set(["SAFE", "AGGRESSIVE"]),
      allowedGrades: new Set(["A", "B"]),
      minDistancePct: null,
      distanceTargetAbs: 6,
      yieldHardCap: 1.35,
      weights: {
        grade: 22,
        yield: 18,
        spread: 16,
        distance: 12,
        quality: 14,
        riskPenalty: 10,
        capitalFit: 10,
        diversificationPenalty: 6,
      },
      // Score: vrai compromis rendement/POP/qualité
      score: (c) => buildCapitalComboScoreBreakdown(c, modeConfigs[1], usableCapital, poolStats).totalScore,
      filterCandidate: (c) => {
        const ov = c._qualityOverlay;
        if (!ov) return true;
        if (ov.qualityTier === "avoid") return false;
        if (ov.qualityTier === "speculative") {
          if (c._popForCombo == null || c._popForCombo < 82) return false;
          if (c.selectedSpreadPct != null && c.selectedSpreadPct > 20) return false;
          if ((c.selectedYieldPct ?? 0) < 0.75) return false;
        }
        return true;
      },
    },
    {
      id: "conservative",
      label: "SAFE",
      // Identity: capital defense — qualité + exécution + distance, pénalise speculative
      tickerCapPct: 0.30,
      positionCapPct: 0.30,
      maxContractsPerTicker: 2,
      minTargetPositions: 3,
      maxThemeCapitalPct: 0.40,
      maxSectorCapitalPct: 0.40,
      maxHighBetaCapitalPct: 0.35,
      minWeeklyYield: 0.5,
      maxWeeklyYield: 0.75,
      minExecutionScore: 0,
      maxSpreadPct: 15,
      allowedModes: new Set(["SAFE"]),
      allowedGrades: new Set(["A", "B"]),
      minDistancePct: null,
      distanceTargetAbs: 8,
      yieldHardCap: 0.95,
      weights: {
        grade: 24,
        yield: 10,
        spread: 18,
        distance: 20,
        quality: 14,
        riskPenalty: 10,
        capitalFit: 10,
        diversificationPenalty: 6,
      },
      // Score: favorise qualité + exécution + distance
      score: (c) => buildCapitalComboScoreBreakdown(c, modeConfigs[2], usableCapital, poolStats).totalScore,
      filterCandidate: (c) => {
        const ov = c._qualityOverlay;
        if (!ov) return true;
        if (ov.qualityTier === "avoid") return false;
        if (ov.qualityTier === "speculative") {
          if (c._popForCombo == null || c._popForCombo < 88) return false;
          if (c.selectedSpreadPct != null && c.selectedSpreadPct > 15) return false;
          if (ov.earningsPenalty > 0) return false;
        }
        return true;
      },
    },
  ];

  function getModeStrike(candidate, modeId) {
  void modeId;
  return {
    strike: Number(candidate?.selectedStrikeValue ?? 0),
    premiumUnit: Number(candidate?.selectedPremiumUnit ?? 0),
    weeklyReturn: Number(candidate?.selectedYieldPct ?? 0),
    spreadPct: candidate?.selectedSpreadPct ?? null,
    distancePct: candidate?.selectedDistancePct ?? null,
    source: candidate?.source ?? "Yahoo fallback",
    premiumKind: candidate?.premiumKind ?? "prime fallback",
    mode: candidate?.finalDisplayMode ?? null,
    grade: candidate?.finalDisplayGrade ?? null,
  };
}

  function makeCombo(mode) {
    const scoredPool = basePool
      .map((candidate) => ({
        ...candidate,
        selectedStrike: getModeStrike(candidate, mode.id),
        _comboScoreBreakdown: buildCapitalComboScoreBreakdown(candidate, mode, usableCapital, poolStats),
      }))
      .filter((candidate) => candidate.capitalPerContract > 0 && candidate.weeklyReturn > 0)
      .filter((candidate) => mode.allowedModes?.has(candidate.finalDisplayMode))
      .filter((candidate) => mode.allowedGrades?.has(candidate.finalDisplayGrade))
      .filter((candidate) => candidate.weeklyReturn >= mode.minWeeklyYield)
      .filter((candidate) => mode.maxWeeklyYield == null || candidate.weeklyReturn < mode.maxWeeklyYield)
      .filter((candidate) => candidate.proExecutionScore >= mode.minExecutionScore)
      .filter((candidate) => candidate.spreadPct == null || candidate.spreadPct <= mode.maxSpreadPct)
      .filter((candidate) =>
        mode.minDistancePct == null ||
        candidate.selectedDistancePct == null ||
        candidate.selectedDistancePct <= mode.minDistancePct
      )
      .filter((candidate) => mode.filterCandidate ? mode.filterCandidate(candidate) : true)
      .map((candidate) => ({
        ...candidate,
        allocScore: candidate._comboScoreBreakdown?.totalScore ?? mode.score(candidate),
      }))
      .sort((a, b) =>
        b.allocScore - a.allocScore ||
        b._comboGradeScore - a._comboGradeScore ||
        (b.selectedYieldPct ?? 0) - (a.selectedYieldPct ?? 0) ||
        (a.selectedSpreadPct ?? Number.POSITIVE_INFINITY) - (b.selectedSpreadPct ?? Number.POSITIVE_INFINITY) ||
        (a.selectedDistancePct ?? 0) - (b.selectedDistancePct ?? 0)
      );
    if (!scoredPool.length) return null;
    const picks = [];
    let used = 0;
    const pickMap = new Map();
    const tickerCapDollars = usableCapital * mode.tickerCapPct;
    const positionCapDollars = usableCapital * mode.positionCapPct;
    const NEUTRAL_CLUSTER_KEYS = new Set(["unknown", "none", "no_theme", "other", ""]);
    const feasibleDistinctTickers = new Set(scoredPool.map((candidate) => candidate.ticker)).size;
    const minTargetPositions = Math.max(
      1,
      Math.min(Number(maxPositions) || 0, Number(mode.minTargetPositions ?? 3), feasibleDistinctTickers)
    );
    let lastRejectionCounts = new Map();

    function computePortfolioState() {
      const tickerCapitalMap = new Map();
      const themeCapitalMap = new Map();
      const sectorCapitalMap = new Map();
      let highBetaCapital = 0;
      let cryptoMinerPositions = 0;
      let speculativePositions = 0;
      for (const pick of picks) {
        tickerCapitalMap.set(pick.ticker, (tickerCapitalMap.get(pick.ticker) ?? 0) + pick.capitalUsed);
        const themeKey = String(pick.concentrationTheme || "").trim().toLowerCase();
        if (themeKey && !NEUTRAL_CLUSTER_KEYS.has(themeKey)) {
          themeCapitalMap.set(themeKey, (themeCapitalMap.get(themeKey) ?? 0) + pick.capitalUsed);
        }
        const sectorKey = String(pick.sectorKey || "").trim().toLowerCase();
        if (sectorKey && !NEUTRAL_CLUSTER_KEYS.has(sectorKey)) {
          sectorCapitalMap.set(sectorKey, (sectorCapitalMap.get(sectorKey) ?? 0) + pick.capitalUsed);
        }
        if (pick.concentrationTheme === "crypto_miner") cryptoMinerPositions += 1;
        if (pick.qualityTier === "speculative") speculativePositions += 1;
        if (pick.isHighBeta === true) highBetaCapital += pick.capitalUsed;
      }
      return {
        tickerCapitalMap,
        themeCapitalMap,
        sectorCapitalMap,
        highBetaCapital,
        cryptoMinerPositions,
        speculativePositions,
        distinctPositions: picks.length,
      };
    }

    function canAddByComposition(candidate, state) {
      const maxCrypto = mode.maxCryptoMinerPositions;
      const maxSpec = mode.maxSpeculativePositions;
      if (maxCrypto == null && maxSpec == null) return { ok: true };
      const ov = candidate._qualityOverlay;
      const theme = ov?.concentrationTheme ?? null;
      const tier = ov?.qualityTier ?? null;
      if (maxCrypto != null && theme === "crypto_miner") {
        const currentCrypto = state.cryptoMinerPositions;
        const hardMax = mode.maxCryptoMinerExceptionCount ?? maxCrypto;
        if (currentCrypto >= hardMax) return { ok: false, reason: "theme_cap_reached" };
        if (currentCrypto >= maxCrypto) {
          const pop = candidate._popForCombo;
          const spread = candidate.spreadPct;
          const quality = ov?.qualityScore ?? 0;
          const ok =
            pop != null && pop >= (mode.maxCryptoMinerExceptionPopMin ?? 82) &&
            (spread == null || spread <= (mode.maxCryptoMinerExceptionSpreadMax ?? 20)) &&
            quality >= (mode.maxCryptoMinerExceptionQualityMin ?? 0.65);
          if (!ok) return { ok: false, reason: "theme_cap_reached" };
        }
      }
      if (maxSpec != null && tier === "speculative") {
        const currentSpec = state.speculativePositions;
        if (currentSpec >= maxSpec) return { ok: false, reason: "caps_too_strict" };
      }
      return { ok: true };
    }

    function hasDiversifyingAlternative(state, excludedTicker = "") {
      return scoredPool.some((candidate) => {
        if (candidate.ticker === excludedTicker) return false;
        if (pickMap.has(candidate.ticker)) return false;
        if (candidate.capitalPerContract <= 0) return false;
        if (used + candidate.capitalPerContract > usableCapital) return false;
        return canAddByComposition(candidate, state).ok;
      });
    }

    function projectLargestPct(map, key, nextCapital, nextUsed) {
      const nextMap = new Map(map);
      if (key) nextMap.set(key, (nextMap.get(key) ?? 0) + nextCapital);
      if (nextUsed <= 0 || nextMap.size === 0) return 0;
      return (Math.max(...nextMap.values()) / nextUsed) * 100;
    }

    function projectDynamicPenalty(state, candidate, nextUsed, isExisting, nextTickerCapital) {
      const themeKey = String(candidate?._qualityOverlay?.concentrationTheme || "").trim().toLowerCase();
      const sectorKey = String(candidate?._tickerMeta?.sector || "").trim().toLowerCase();
      const largestTickerPct = nextUsed > 0 ? (nextTickerCapital / nextUsed) * 100 : 0;
      const largestThemePct = projectLargestPct(
        state.themeCapitalMap,
        themeKey && !NEUTRAL_CLUSTER_KEYS.has(themeKey) ? themeKey : null,
        candidate.capitalPerContract,
        nextUsed
      );
      const largestSectorPct = projectLargestPct(
        state.sectorCapitalMap,
        sectorKey && !NEUTRAL_CLUSTER_KEYS.has(sectorKey) ? sectorKey : null,
        candidate.capitalPerContract,
        nextUsed
      );
      const nextHighBetaCapital =
        state.highBetaCapital + (candidate?._qualityOverlay?.concentrationTheme === "high_beta_growth" ? candidate.capitalPerContract : 0);
      const nextHighBetaPct = nextUsed > 0 ? (nextHighBetaCapital / nextUsed) * 100 : 0;
      let penalty = 0;
      penalty += Math.max(0, largestTickerPct - 30) * 0.9;
      penalty += Math.max(0, largestThemePct - 45) * 0.55;
      penalty += Math.max(0, largestSectorPct - 45) * 0.45;
      penalty += Math.max(0, nextHighBetaPct - 40) * 0.6;
      if (isExisting) penalty += 6;
      return { penalty };
    }

    function evaluateCandidate(candidate, useSoftCaps = false) {
      const existing = pickMap.get(candidate.ticker);
      const isExisting = !!existing;
      const currentContracts = existing?.contracts ?? 0;
      const state = computePortfolioState();
      const nextUsed = used + candidate.capitalPerContract;
      const maxContractsAllowed = useSoftCaps ? mode.maxContractsPerTicker + 1 : mode.maxContractsPerTicker;
      const nextPositionCapital = (currentContracts + 1) * candidate.capitalPerContract;
      const tickerCapLimit = useSoftCaps ? tickerCapDollars * 1.1 : tickerCapDollars;
      const positionCapLimit = useSoftCaps ? positionCapDollars * 1.1 : positionCapDollars;
      const nextDistinctPositions = isExisting ? state.distinctPositions : state.distinctPositions + 1;

      if (candidate.capitalPerContract <= 0) return { ok: false, reason: "contract_size_too_large" };
      if (currentContracts >= maxContractsAllowed) return { ok: false, reason: "ticker_cap_reached" };
      if (!isExisting && state.distinctPositions >= maxPositions) return { ok: false, reason: "max_positions_limit" };
      if (nextUsed > usableCapital) return { ok: false, reason: "contract_size_too_large" };
      if (nextPositionCapital > tickerCapLimit || nextPositionCapital > positionCapLimit) {
        return { ok: false, reason: "ticker_cap_reached" };
      }

      const composition = canAddByComposition(candidate, state);
      if (!composition.ok) return { ok: false, reason: composition.reason ?? "caps_too_strict" };

      if (
        isExisting &&
        state.distinctPositions < minTargetPositions &&
        hasDiversifyingAlternative(state, candidate.ticker)
      ) {
        return { ok: false, reason: "ticker_cap_reached" };
      }

      const themeKey = String(candidate?._qualityOverlay?.concentrationTheme || "").trim().toLowerCase();
      const sectorKey = String(candidate?._tickerMeta?.sector || "").trim().toLowerCase();
      const nextTickerCapital = (state.tickerCapitalMap.get(candidate.ticker) ?? 0) + candidate.capitalPerContract;
      const nextThemeCapital =
        themeKey && !NEUTRAL_CLUSTER_KEYS.has(themeKey)
          ? (state.themeCapitalMap.get(themeKey) ?? 0) + candidate.capitalPerContract
          : 0;
      const nextSectorCapital =
        sectorKey && !NEUTRAL_CLUSTER_KEYS.has(sectorKey)
          ? (state.sectorCapitalMap.get(sectorKey) ?? 0) + candidate.capitalPerContract
          : 0;
      const nextHighBetaCapital =
        state.highBetaCapital + (candidate?._qualityOverlay?.concentrationTheme === "high_beta_growth" ? candidate.capitalPerContract : 0);
      const enforceClusterCaps = nextDistinctPositions >= minTargetPositions || !hasDiversifyingAlternative(state, candidate.ticker);

      if (enforceClusterCaps) {
        if (nextUsed > 0 && (nextTickerCapital / nextUsed) > (useSoftCaps ? mode.tickerCapPct * 1.08 : mode.tickerCapPct)) {
          return { ok: false, reason: "ticker_cap_reached" };
        }
        if (
          themeKey &&
          !NEUTRAL_CLUSTER_KEYS.has(themeKey) &&
          nextUsed > 0 &&
          (nextThemeCapital / nextUsed) > (useSoftCaps ? (mode.maxThemeCapitalPct ?? 0.45) * 1.08 : (mode.maxThemeCapitalPct ?? 0.45))
        ) {
          return { ok: false, reason: "theme_cap_reached" };
        }
        if (
          sectorKey &&
          !NEUTRAL_CLUSTER_KEYS.has(sectorKey) &&
          nextUsed > 0 &&
          (nextSectorCapital / nextUsed) > (useSoftCaps ? (mode.maxSectorCapitalPct ?? 0.45) * 1.08 : (mode.maxSectorCapitalPct ?? 0.45))
        ) {
          return { ok: false, reason: "sector_cap_reached" };
        }
        if (
          nextUsed > 0 &&
          (nextHighBetaCapital / nextUsed) > (useSoftCaps ? (mode.maxHighBetaCapitalPct ?? 0.40) * 1.08 : (mode.maxHighBetaCapitalPct ?? 0.40))
        ) {
          return { ok: false, reason: "high_beta_cap_reached" };
        }
      }

      const projected = projectDynamicPenalty(state, candidate, nextUsed, isExisting, nextTickerCapital);
      const diversificationBonus = !isExisting
        ? (state.distinctPositions < minTargetPositions ? 16 : 7)
        : 0;
      const marginalScore = Number(candidate.allocScore ?? 0) + diversificationBonus - projected.penalty;
      const selectionReasonParts = [candidate._comboScoreBreakdown?.selectionReason ?? "selected: portfolio fit"];
      if (!isExisting && state.distinctPositions < minTargetPositions) {
        selectionReasonParts.push("portfolio: nouvelle ligne priorisée pour diversification");
      } else if (!isExisting) {
        selectionReasonParts.push("portfolio: diversification ajoutée sans dégrader le budget");
      } else {
        selectionReasonParts.push("portfolio: renfort accepté après caps et diversification");
      }

      return {
        ok: true,
        candidate,
        existing,
        isExisting,
        marginalScore,
        selectionReason: selectionReasonParts.join(" · "),
      };
    }

    function pickBestCandidate(useSoftCaps = false) {
      const rejections = new Map();
      let best = null;
      for (const candidate of scoredPool) {
        const evaluated = evaluateCandidate(candidate, useSoftCaps);
        if (!evaluated.ok) {
          const key = evaluated.reason ?? "caps_too_strict";
          rejections.set(key, (rejections.get(key) ?? 0) + 1);
          continue;
        }
        if (
          !best ||
          evaluated.marginalScore > best.marginalScore ||
          (
            evaluated.marginalScore === best.marginalScore &&
            (evaluated.candidate.allocScore ?? 0) > (best.candidate.allocScore ?? 0)
          )
        ) {
          best = evaluated;
        }
      }
      lastRejectionCounts = rejections;
      return best;
    }

    function createPick(candidate, selectionReason) {
      return {
        ticker: candidate.ticker,
        mode: candidate.finalDisplayMode,
        grade: candidate.finalDisplayGrade,
        strike: candidate.selectedStrike.strike,
        source: candidate.source,
        premiumKind: candidate.premiumKind,
        premiumUnit: candidate.selectedStrike.premiumUnit,
        contracts: 1,
        capitalRequired: candidate.capitalPerContract,
        capitalUsed: candidate.capitalPerContract,
        premiumCollected: candidate.premiumPerContract,
        weeklyReturn: candidate.weeklyReturn,
        spreadPct: candidate.selectedSpreadPct,
        distancePct: candidate.selectedDistancePct,
        qualityTier: candidate._qualityOverlay?.qualityTier ?? null,
        qualityScore: candidate._qualityOverlay?.qualityScore ?? null,
        qualityWarnings: candidate._qualityOverlay?.qualityWarnings ?? [],
        concentrationTheme: candidate._qualityOverlay?.concentrationTheme ?? null,
        sectorKey: String(candidate?._tickerMeta?.sector || "").trim().toLowerCase(),
        isHighBeta: candidate?._qualityOverlay?.concentrationTheme === "high_beta_growth",
        premiumTrapPenalty: candidate._qualityOverlay?.premiumTrapPenalty ?? 0,
        popEstimate: candidate._popForCombo ?? null,
        selectionScore: candidate._comboScoreBreakdown?.totalScore ?? candidate.allocScore ?? 0,
        selectionSummary: candidate._comboScoreBreakdown?.summary ?? null,
        selectionReason,
        selectionTooltip: candidate._comboScoreBreakdown?.tooltip ?? null,
      };
    }

    function applySelection(selection) {
      const { candidate, existing, isExisting, selectionReason } = selection;
      if (!isExisting) {
        const pick = createPick(candidate, selectionReason);
        picks.push(pick);
        pickMap.set(candidate.ticker, pick);
      } else {
        existing.contracts += 1;
        existing.capitalUsed += candidate.capitalPerContract;
        existing.premiumCollected += candidate.premiumPerContract;
        existing.selectionScore = Math.max(
          existing.selectionScore ?? 0,
          candidate._comboScoreBreakdown?.totalScore ?? candidate.allocScore ?? 0
        );
        existing.selectionReason = selectionReason;
      }
      used += candidate.capitalPerContract;
    }

    while (true) {
      const best = pickBestCandidate(false);
      if (best) {
        applySelection(best);
        continue;
      }
      const currentPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
      if (currentPct >= targetGoalPct) break;
      const softBest = pickBestCandidate(true);
      if (!softBest) break;
      applySelection(softBest);
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
      } else if ((lastRejectionCounts.get("ticker_cap_reached") ?? 0) > 0) {
        capitalShortfallReason = "ticker_cap_reached";
      } else if ((lastRejectionCounts.get("theme_cap_reached") ?? 0) > 0) {
        capitalShortfallReason = "theme_cap_reached";
      } else if ((lastRejectionCounts.get("sector_cap_reached") ?? 0) > 0) {
        capitalShortfallReason = "sector_cap_reached";
      } else if ((lastRejectionCounts.get("high_beta_cap_reached") ?? 0) > 0) {
        capitalShortfallReason = "high_beta_cap_reached";
      } else if (usedPct >= 70) {
        capitalShortfallReason = "no_clean_incremental_candidate";
      } else {
        capitalShortfallReason = "caps_too_strict";
      }
    }

    const qualityStats = picks.reduce(
      (acc, p) => {
        if (p.qualityTier === "avoid") acc.avoidCount++;
        if (p.qualityTier === "speculative") acc.speculativeCount++;
        if ((p.premiumTrapPenalty ?? 0) >= 0.30) acc.premiumTrapCount++;
        if (p.concentrationTheme === "crypto_miner") acc.cryptoMinerCount++;
        if (p.concentrationTheme === "high_beta_growth") acc.highBetaGrowthCount++;
        acc.totalQualityScore += p.qualityScore ?? 0.5;
        return acc;
      },
      { avoidCount: 0, speculativeCount: 0, premiumTrapCount: 0, cryptoMinerCount: 0, highBetaGrowthCount: 0, totalQualityScore: 0 }
    );

    // Concentration metrics — Phase 4D-4
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const tickerCapMapConc = new Map();
    const themeCapMapConc = new Map();
    const NEUTRAL_THEMES_SET = new Set(["unknown", "none", "no_theme", "other", ""]);
    for (const p of picks) {
      tickerCapMapConc.set(p.ticker, (tickerCapMapConc.get(p.ticker) ?? 0) + p.capitalUsed);
      const theme = p.concentrationTheme;
      if (theme != null && !NEUTRAL_THEMES_SET.has(theme)) {
        themeCapMapConc.set(theme, (themeCapMapConc.get(theme) ?? 0) + p.capitalUsed);
      }
    }
    const largestTickerCapitalPct = used > 0 && tickerCapMapConc.size > 0
      ? (Math.max(...tickerCapMapConc.values()) / used) * 100 : 0;
    const cryptoMinerCapitalPct = used > 0
      ? ((themeCapMapConc.get("crypto_miner") ?? 0) / used) * 100 : 0;
    const highBetaCapitalPct = used > 0
      ? ((themeCapMapConc.get("high_beta_growth") ?? 0) / used) * 100 : 0;
    const largestThemeCapitalPct = used > 0 && themeCapMapConc.size > 0
      ? (Math.max(...themeCapMapConc.values()) / used) * 100 : 0;
    const concentrationRiskScore = clamp01(
      0.35 * clamp01(largestTickerCapitalPct / 25) +
      0.35 * clamp01(largestThemeCapitalPct / 45) +
      0.20 * clamp01(cryptoMinerCapitalPct / 35) +
      0.10 * clamp01(highBetaCapitalPct / 40)
    );
    const diversificationHealthScore = clamp01(1 - concentrationRiskScore);
    const clusterWarnings = [];
    if (cryptoMinerCapitalPct > 35) clusterWarnings.push(`Crypto/miner ${cryptoMinerCapitalPct.toFixed(0)}% du capital`);
    if (highBetaCapitalPct > 40) clusterWarnings.push(`High beta ${highBetaCapitalPct.toFixed(0)}% du capital`);
    if (largestTickerCapitalPct > 25) clusterWarnings.push(`Ticker dominant ${largestTickerCapitalPct.toFixed(0)}% du capital`);
    if (largestThemeCapitalPct > 45) clusterWarnings.push(`Thème dominant ${largestThemeCapitalPct.toFixed(0)}% du capital`);
    if (qualityStats.speculativeCount >= 3) clusterWarnings.push(`${qualityStats.speculativeCount} positions spéculatives`);

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
      avgQualityScore: picks.length > 0 ? qualityStats.totalQualityScore / picks.length : null,
      qualityAvoidCount: qualityStats.avoidCount,
      qualitySpeculativeCount: qualityStats.speculativeCount,
      qualityPremiumTrapCount: qualityStats.premiumTrapCount,
      qualityCryptoMinerCount: qualityStats.cryptoMinerCount,
      qualityHighBetaGrowthCount: qualityStats.highBetaGrowthCount,
      largestTickerCapitalPct,
      cryptoMinerCapitalPct,
      highBetaCapitalPct,
      largestThemeCapitalPct,
      concentrationRiskScore,
      diversificationHealthScore,
      clusterWarnings,
    };
  }

  function computeCrossModeOverlapLocal(combosArr) {
    if (!combosArr || combosArr.length < 2) return null;
    const modeSets = combosArr.map(combo => ({
      label: combo.label,
      tickers: new Set((combo.picks ?? []).map(p => p.ticker)),
    }));
    const allTickerSets = modeSets.map(m => m.tickers);
    const unionTickers = new Set(allTickerSets.flatMap(s => [...s]));
    const inAtLeastTwo = [];
    const inAll = [];
    for (const ticker of unionTickers) {
      const count = allTickerSets.filter(s => s.has(ticker)).length;
      if (count >= 2) inAtLeastTwo.push(ticker);
      if (count === allTickerSets.length) inAll.push(ticker);
    }
    const maxSetSize = Math.max(...modeSets.map(m => m.tickers.size));
    const overlapTickerCount = inAtLeastTwo.length;
    const overlapTickerPct = maxSetSize > 0 ? (overlapTickerCount / maxSetSize) * 100 : 0;
    let crossModeConcentrationRisk = "LOW";
    if (inAll.length >= 4) crossModeConcentrationRisk = "HIGH";
    else if (inAll.length >= 2 || overlapTickerPct > 50) crossModeConcentrationRisk = "MEDIUM";
    const crossModeWarnings = [];
    if (inAll.length >= 3) crossModeWarnings.push(`${inAll.length} tickers communs aux ${allTickerSets.length} modes : ${inAll.join(", ")}`);
    if (overlapTickerPct > 50) crossModeWarnings.push(`Overlap entre modes : ${overlapTickerCount} ticker${overlapTickerCount > 1 ? "s" : ""} présent${overlapTickerCount > 1 ? "s" : ""} dans au moins 2 modes${inAtLeastTwo.length > 0 ? " : " + inAtLeastTwo.join(", ") : ""}`);
    return { overlapTickerCount, overlapTickerPct, commonTickers: inAtLeastTwo, inAllModes: inAll, crossModeConcentrationRisk, crossModeWarnings };
  }

  const builtCombos = modeConfigs.map((mode) => makeCombo(mode)).filter(Boolean);
  if (!builtCombos.length) return builtCombos;
  const crossModeOverlap = computeCrossModeOverlapLocal(builtCombos);
  return builtCombos.map(combo => ({ ...combo, crossModeOverlap }));
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

function FaceplateMetric({ label, value, sub = null, tone = "default", strong = false }) {
  const toneClass =
    tone === "good"
      ? "text-[#21ff7a]"
      : tone === "warn"
      ? "text-[#ffb21a]"
      : tone === "bad"
      ? "text-[#ff273a]"
      : tone === "cyan"
      ? "text-[#00c8ff]"
      : tone === "magenta"
      ? "text-[#f05cff]"
      : tone === "orange"
      ? "text-[#ff9f0a]"
      : tone === "violet"
      ? "text-[#c76bff]"
      : "text-slate-50";

  return (
    <div className="min-h-[68px] rounded-[6px] border border-[#172637] bg-[#06111b]/95 px-3 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_18px_rgba(0,170,255,0.025)]">
      <p className="text-[11px] font-medium tracking-wide text-slate-200/90">{label}</p>
      <p className={cn("mt-1 text-lg leading-tight", strong && "font-semibold", toneClass)}>{value}</p>
      {sub && <p className="mt-0.5 text-xs leading-tight text-slate-400">{sub}</p>}
    </div>
  );
}

function FaceplateStrikeColumn({
  title,
  tone = "safe",
  strikeData,
  fallbackDte,
  isSelected = false,
  selectedGrade = null,
  selectedMode = null,
  displayGrade = null,
  debugLabel = null,
}) {
  if (!strikeData) {
    return (
      <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/50 p-4 text-sm text-slate-400">
        Aucun strike {tone === "safe" ? "safe" : "agressif"} snapshot.
      </div>
    );
  }

  const strikeNumber = Number(strikeData.strike);
  const displayedPremium = Number.isFinite(Number(strikeData.premiumUsed))
    ? Number(strikeData.premiumUsed)
    : Number.isFinite(Number(strikeData.mid))
    ? Number(strikeData.mid)
    : null;
  const distanceNumber = Number(strikeData.distancePct);
  const tradeYieldNumber = Number(strikeData.weeklyYield);
  const weeklyNormalizedYieldNumber = Number(strikeData.weeklyNormalizedYield);
  const annualizedYieldNumber = Number(strikeData.annualizedYield);
  const popProfitNumber = Number(strikeData.popProfitEstimated ?? strikeData.popEstimate);
  const popOtmNumber = Number(strikeData.popOtmEstimated);
  const dteNumber = Number(strikeData.dteDays ?? fallbackDte);
  const rend7j =
    Number.isFinite(dteNumber) && dteNumber > 0 && Number.isFinite(weeklyNormalizedYieldNumber) && weeklyNormalizedYieldNumber > 0
      ? weeklyNormalizedYieldNumber
      : null;
  const annualise7j = rend7j != null ? rend7j * 52 : null;
  const spreadClass = classifySpreadPctPercent(strikeData.liquidity?.spreadPct);
  const accent = tone === "safe" ? "text-[#00c8ff]" : "text-[#e052ff]";
  const border = tone === "safe" ? "border-[#12354a]" : "border-[#3b1a4a]";
  const glow = tone === "safe" ? "shadow-sky-950/30" : "shadow-fuchsia-950/30";
  const hasSelection =
    isSelected && (selectedGrade === "A" || selectedGrade === "B" || selectedGrade === "WATCH");
  const selectionBorder = !hasSelection
    ? border
    : selectedGrade === "WATCH"
    ? "border-amber-500 ring-2 ring-amber-300/55 shadow-[0_0_0_1px_rgba(245,158,11,0.18)]"
    : "border-emerald-500 ring-2 ring-emerald-300/55 shadow-[0_0_0_1px_rgba(16,185,129,0.18)]";
  const selectionBadgeClass = selectedGrade === "WATCH"
    ? "border border-amber-300 bg-amber-50 text-amber-900"
    : "border border-emerald-300 bg-emerald-50 text-emerald-800";
  const titleText = tone === "safe" ? "SAFE (IBKR live)" : "AGRESSIF (IBKR live)";
  const subtitleText = tone === "safe" ? "safe IBKR live" : "agressif IBKR live";
  const metricRows = [
    {
      label: "Strike",
      value: Number.isFinite(strikeNumber) ? strikeNumber.toFixed(2) : "—",
      tone: accent,
      strong: true,
    },
    {
      label: strikeData.premiumLabel || "Prime utilisée",
      value: displayedPremium != null ? `$${displayedPremium.toFixed(2)}` : "—",
      tone: "text-[#21ff7a]",
      strong: true,
    },
    {
      label: "Rendement",
      value: Number.isFinite(tradeYieldNumber) ? `${tradeYieldNumber.toFixed(2)}%` : "—",
      sub: "jusqu'à expiration",
      tone: "text-[#21ff7a]",
      strong: true,
    },
    ...(rend7j != null
      ? [
          {
            label: "Rend. 7J",
            value: `${rend7j.toFixed(2)}%`,
            tone: "text-[#21ff7a]",
            strong: true,
          },
          {
            label: "Annualisé 7J",
            value: `${annualise7j.toFixed(1)}%`,
            tone: "text-[#21ff7a]",
            strong: true,
          },
        ]
      : []),
    {
      label: "Distance",
      value: Number.isFinite(distanceNumber) ? `${distanceNumber.toFixed(1)}%` : "—",
      tone: "text-slate-50",
    },
    {
      label: "POP estimée",
      value: Number.isFinite(popProfitNumber) ? `${(popProfitNumber * 100).toFixed(1)}%` : "—",
      tone: "text-[#21ff7a]",
      strong: true,
    },
    {
      label: "DTE",
      value: Number.isFinite(dteNumber) ? `${dteNumber} jours` : "—",
      sub: Number.isFinite(popOtmNumber) ? `OTM estimé ${(popOtmNumber * 100).toFixed(1)}%` : "OTM estimé —",
      tone: "text-[#21ff7a]",
      strong: true,
    },
  ];

  return (
    <div className={cn("rounded-[8px] border bg-[#050d16]/95 p-3 shadow-lg", selectionBorder, glow)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={cn("text-sm font-semibold tracking-wide", accent)}>{titleText}</p>
          <p className="mt-1 text-xs text-slate-500">{strikeData.label || subtitleText}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {hasSelection && (
            <Badge className={cn("rounded-full px-2.5 py-1 text-xs", selectionBadgeClass)}>
              Sélectionné{selectedGrade ? ` [${selectedGrade}]` : ""}
            </Badge>
          )}
          <Badge className="rounded-full border border-slate-700 bg-slate-950/80 px-2.5 py-1 text-xs text-slate-300">
            PUT
          </Badge>
        </div>
      </div>

      <div className="mt-3 rounded-[7px] border border-[#172637] bg-[#06111b]/95 px-3 py-2 text-[11px] text-slate-400">
        {`selected=${hasSelection ? "true" : "false"} • mode=${selectedMode ?? "—"} • grade=${displayGrade ?? selectedGrade ?? "—"}${debugLabel ? ` • ${debugLabel}` : ""}`}
      </div>

      <div className="mt-3 grid grid-cols-1 gap-y-2.5">
        {metricRows.map((row) => (
          <div key={row.label} className="min-h-[42px]">
            <p className="text-xs leading-tight text-slate-400">{row.label}</p>
            <p className={cn("mt-1 text-[15px] leading-tight tabular-nums", row.strong && "font-semibold", row.tone)}>
              {row.value}
            </p>
            {row.sub && <p className="mt-0.5 text-[11px] leading-tight text-slate-500">{row.sub}</p>}
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-[7px] border border-[#172637] bg-[#06111b]/95 px-3 py-3 text-sm text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.035)]">
        <p className={cn("mb-2 text-sm font-semibold", accent)}>Marché live</p>
        <div className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-2 gap-y-2">
          <span className="text-slate-400">Bid</span>
          <span className="font-semibold tabular-nums text-white">{formatMoneyOrDash(strikeData.bid)}</span>
          <span className="text-slate-400">Ask</span>
          <span className="font-semibold tabular-nums text-white">{formatMoneyOrDash(strikeData.ask)}</span>
          <span className="text-slate-400">Mid</span>
          <span className="font-semibold tabular-nums text-white">{formatMoneyOrDash(strikeData.mid)}</span>
          <span className="text-slate-400">Spread</span>
          <span className={cn("font-semibold tabular-nums", spreadClass.metricTone === "bad" ? "text-[#ff273a]" : spreadClass.metricTone === "warn" ? "text-[#ffb21a]" : "text-[#21ff7a]")}>
            {strikeData.liquidity?.spreadPct != null ? `${Number(strikeData.liquidity.spreadPct).toFixed(2)}%` : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function MiniTradeLevelsChart({ item }) {
  const closes = Array.isArray(item?.priceSeries?.closes)
    ? item.priceSeries.closes.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const rawDates = Array.isArray(item?.priceSeries?.dates)
    ? item.priceSeries.dates
    : Array.isArray(item?.priceSeries?.timestamps)
    ? item.priceSeries.timestamps
    : [];
  const visibleCloses = closes.slice(-60);
  const visibleDates = rawDates.slice(-visibleCloses.length);
  const price = Number(item?.price);
  const safeStrike = Number(item?.safeStrike?.strike);
  const safeMid = Number(item?.safeStrike?.mid ?? item?.safeStrike?.premiumUsed);
  const expectedMoveLow = Number(item?.expectedMoveLow);
  const expectedMoveHigh = Number(item?.expectedMoveHigh);
  const supportNear = Number(item?.supportNear);
  const supportWide = Number(item?.supportWide ?? item?.support);
  const potentialSupport =
    Number(item?.potentialSupportFromBrokenResistance) ||
    (item?.resistanceStatus === "broken" ? Number(item?.resistanceCurrent ?? item?.resistance) : NaN);
  const resistanceAboveSpot = Number(item?.resistanceAboveSpot ?? item?.resistanceCurrent ?? item?.resistance);
  const levels = [
    ...visibleCloses,
    price,
    safeStrike,
    expectedMoveLow,
    expectedMoveHigh,
    supportNear,
    supportWide,
    potentialSupport,
    resistanceAboveSpot,
  ].filter((value) => Number.isFinite(value) && value > 0);
  const hasSeries = visibleCloses.length >= 2;
  const rawMin = levels.length ? Math.min(...levels) : 0;
  const rawMax = levels.length ? Math.max(...levels) : 1;
  const rawRange = rawMax - rawMin || Math.max(rawMax * 0.08, 1);
  const min = Math.floor((rawMin - rawRange * 0.06) / 5) * 5;
  const max = Math.ceil((rawMax + rawRange * 0.04) / 5) * 5;
  const range = max - min || 1;
  const width = 640;
  const height = 248;
  const padLeft = 44;
  const padRight = 36;
  const padTop = 12;
  const padBottom = 28;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const xForIndex = (index) =>
    padLeft + (visibleCloses.length <= 1 ? 0 : (index / (visibleCloses.length - 1)) * chartWidth);
  const yForValue = (value) => padTop + ((max - value) / range) * chartHeight;
  const points = visibleCloses
    .map((value, index) => `${xForIndex(index).toFixed(1)},${yForValue(value).toFixed(1)}`)
    .join(" ");
  const levelRows = [
    { label: "EM haut", value: expectedMoveHigh, className: "text-[#ff9f0a]", color: "#ff9f0a" },
    { label: "Résistance sup.", value: resistanceAboveSpot, className: "text-[#c76bff]", color: "#c76bff" },
    { label: "Spot", value: price, className: "text-[#00c8ff]", color: "#00c8ff" },
    { label: "S. proche", value: supportNear, className: "text-[#21ff7a]", color: "#21ff7a" },
    { label: "Strike safe", value: safeStrike, className: "text-[#ff273a]", color: "#ff273a" },
    { label: "EM bas", value: expectedMoveLow, className: "text-[#ffb21a]", color: "#ffb21a" },
    { label: "S. potentiel", value: potentialSupport, className: "text-[#10d6a3]", color: "#10d6a3" },
    { label: "S. large", value: supportWide, className: "text-[#26e6c2]", color: "#26e6c2" },
  ].filter((row) => Number.isFinite(row.value) && row.value > 0);
  const levelLabels = levelRows
    .map((row) => ({ ...row, lineY: yForValue(row.value), labelY: yForValue(row.value) - 5 }))
    .sort((a, b) => a.labelY - b.labelY)
    .reduce((acc, row) => {
      const previous = acc[acc.length - 1];
      const minGap = 15;
      const topLimit = padTop + 8;
      const bottomLimit = height - padBottom - 4;
      const labelY = Math.min(
        bottomLimit,
        Math.max(previous ? previous.labelY + minGap : topLimit, row.labelY)
      );
      acc.push({ ...row, labelY });
      return acc;
    }, []);
  const labelYByName = new Map(levelLabels.map((row) => [row.label, row.labelY]));
  const yTicks = Array.from({ length: Math.floor((max - min) / 5) + 1 }, (_, index) => max - index * 5)
    .filter((value) => value >= min && value <= max);
  const monthLabels = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const parseChartDate = (raw) => {
    if (raw == null) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const formatChartDate = (date) => `${date.getDate()} ${monthLabels[date.getMonth()]}`;
  const fallbackEndDate = parseChartDate(item?.asOf ?? item?.raw?.asOf ?? item?.scanTimestamp) ?? new Date();
  const xTickIndexes = [0, 7, 14, 21, 28, 35, 42, 49, Math.max(0, visibleCloses.length - 1)]
    .filter((index, pos, arr) => index < visibleCloses.length && arr.indexOf(index) === pos);
  const xTicks = xTickIndexes.map((index) => {
    const parsed = parseChartDate(visibleDates[index]);
    const approx = new Date(fallbackEndDate);
    approx.setDate(fallbackEndDate.getDate() - (visibleCloses.length - 1 - index));
    return {
      index,
      label: formatChartDate(parsed ?? approx),
    };
  });

  return (
    <div className="rounded-[8px] border border-[#172637] bg-[#020811] p-3 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_24px_rgba(0,170,255,0.035)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-white">Mini carte technique — 60 derniers jours</p>
          <p className="mt-1 text-xs text-slate-400">
            Niveaux trade / supports / expected move.
          </p>
        </div>
        <Badge className="rounded-full border border-fuchsia-700 bg-fuchsia-950/70 text-fuchsia-100">
          PUT {Number.isFinite(safeStrike) ? `${safeStrike.toFixed(0)}` : "—"}
          {Number.isFinite(safeMid) ? ` @ ${safeMid.toFixed(2)}` : ""}
        </Badge>
      </div>

      <div className="mt-3 rounded-[7px] border border-[#132536] bg-[#030b14] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_26px_rgba(0,169,255,0.035)]">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_178px]">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[285px] w-full" role="img" aria-label="Mini-graphe des niveaux de prix">
          <defs>
            <linearGradient id={`mini-chart-bg-${item.ticker}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#06131f" />
              <stop offset="100%" stopColor="#020811" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width={width} height={height} fill={`url(#mini-chart-bg-${item.ticker})`} rx="6" />
          {[0.16, 0.32, 0.48, 0.64, 0.8].map((ratio) => (
            <line
              key={`v-${ratio}`}
              x1={padLeft + ratio * chartWidth}
              x2={padLeft + ratio * chartWidth}
              y1={padTop}
              y2={height - padBottom}
              stroke="#132536"
              strokeWidth="1"
              opacity="0.65"
            />
          ))}
          {yTicks.map((tick) => (
            <g key={`ytick-${tick}`}>
              <line
                x1={padLeft}
                x2={width - padRight}
                y1={yForValue(tick)}
                y2={yForValue(tick)}
                stroke="#163047"
                strokeWidth="1"
                opacity="0.72"
              />
              <text x={width - padRight + 14} y={yForValue(tick) + 4} textAnchor="start" fill="#e5edf7" fontSize="12" fontWeight="600">
                {tick}
              </text>
            </g>
          ))}
          {levelRows.map((row) => {
            const y = yForValue(row.value);
            const labelY = labelYByName.get(row.label) ?? y - 5;
            return (
              <g key={row.label}>
                <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke={row.color} strokeDasharray="7 7" strokeWidth="1.5" opacity="0.92" />
              </g>
            );
          })}
          {hasSeries ? (
            <polyline fill="none" stroke="#00a9ff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" points={points} />
          ) : (
            <text x={width / 2} y={height / 2} textAnchor="middle" fill="#94a3b8" fontSize="14">
              Historique indisponible
            </text>
          )}
          <line x1={padLeft} x2={width - padRight} y1={height - padBottom} y2={height - padBottom} stroke="#24364a" strokeWidth="1" />
          {xTicks.map((tick) => (
            <text key={`xtick-${tick.index}`} x={xForIndex(tick.index)} y={height - 10} textAnchor="middle" fill="#e5edf7" fontSize="12" fontWeight="600">
              {tick.label}
            </text>
          ))}
        </svg>
        <div className="hidden min-w-[168px] flex-col justify-center gap-2 border-l border-[#132536] pl-4 text-sm xl:flex">
          {levelRows.map((row) => (
            <div key={`legend-${row.label}`} className="flex items-center justify-between gap-3">
              <span className={cn("flex items-center gap-2 font-semibold", row.className)}>
                <span className="h-2 w-2 rounded-full shadow-[0_0_10px_currentColor]" style={{ backgroundColor: row.color, color: row.color }} />
                {row.label}
              </span>
              <span className={cn("font-semibold tabular-nums", row.className)}>${Number(row.value).toFixed(2)}</span>
            </div>
          ))}
        </div>
        </div>
      </div>

      <div className="mt-2 border-t border-[#132536] px-1 pt-2 text-sm text-slate-100">
        Mouvement attendu : {item.expectedMovePct.toFixed(2)}% <span className="px-3 text-slate-400">•</span>
        Plage attendue : ${item.expectedMoveLow.toFixed(2)} - ${item.expectedMoveHigh.toFixed(2)} <span className="px-3 text-slate-400">•</span>
        {Number.isFinite(Number(item.targetPremium)) && Number(item.targetPremium) > 0 ? (
          <>Prime cible ${Number(item.targetPremium).toFixed(2)} <span className="px-3 text-slate-400">•</span></>
        ) : null}
        Strike Safe : {item.safeStrike?.strike != null ? `$${Number(item.safeStrike.strike).toFixed(2)}` : "—"}
        {Number.isFinite(safeMid) ? ` (prime $${safeMid.toFixed(2)})` : ""} <span className="px-3 text-slate-400">•</span>
        Rendement : {item.weeklyReturn != null && Number.isFinite(Number(item.weeklyReturn)) ? `${Number(item.weeklyReturn).toFixed(2)}% jusqu'à expiration` : "—"}
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-3 xl:hidden">
        {levelRows.map((row) => (
          <div key={row.label} className="rounded-[6px] border border-[#132536] bg-[#06111b]/80 px-2 py-1.5">
            <span className={cn("font-semibold", row.className)}>{row.label}</span>
            <span className="ml-1 text-slate-300">${Number(row.value).toFixed(2)}</span>
          </div>
        ))}
      </div>
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
  dteDays,
  tradeYield,
  weeklyNormalizedYield,
  annualizedYield,
  distancePct,
  label,
  meetsTarget,
  liquidity,
  isSelected = false,
  selectedGrade = null,
  recommendedMode = null,
  recommendedGrade = null,
  recommendationDiagnostics = null,
  legKey = null,
}) {
  const strikeNumber = Number(strike);
  const distanceNumber = Number(distancePct);
  const hasStrikeNumber = Number.isFinite(strikeNumber);
  const hasDistanceNumber = Number.isFinite(distanceNumber);
  const distanceTone = !hasDistanceNumber
    ? "default"
    : distanceNumber <= -10
    ? "good"
    : distanceNumber <= -5
    ? "warn"
    : "bad";
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
  const tradeYieldNumber = Number(tradeYield);
  const weeklyNormalizedYieldNumber = Number(weeklyNormalizedYield);
  const annualizedYieldNumber = Number(annualizedYield);
  const popOtmEstimatedNumber = Number(popOtmEstimated);
  const yieldOk = Number.isFinite(tradeYieldNumber);
  const yieldTone =
    !yieldOk || tradeYield == null
      ? "default"
      : tradeYieldNumber >= 1
      ? "good"
      : tradeYieldNumber >= 0.5
      ? "warn"
      : "bad";
  const objectiveResolved = meetsTarget && hasPremiumNumber && yieldOk;
  const mainPop = popProfitEstimated ?? popEstimate ?? null;
  const mainPopNumber = Number(mainPop);
  const popTone =
    !Number.isFinite(mainPopNumber)
      ? "default"
      : mainPopNumber >= 0.75
      ? "good"
      : mainPopNumber >= 0.6
      ? "warn"
      : "bad";
  const spreadClass = classifySpreadPctPercent(liquidity?.spreadPct);

  const selectedBorder = isSelected
    ? selectedGrade === "WATCH"
      ? "border-amber-500 ring-2 ring-amber-300/60 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]"
      : "border-emerald-500 ring-2 ring-emerald-300/60 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]"
    : "border-slate-200";
  const diagGrade =
    legKey === "safe" ? recommendationDiagnostics?.safeGrade : recommendationDiagnostics?.aggressiveGrade;
  const diagYield =
    legKey === "safe" ? recommendationDiagnostics?.safeYieldPct : recommendationDiagnostics?.aggressiveYieldPct;
  const diagSpread =
    legKey === "safe"
      ? recommendationDiagnostics?.safeSpreadPct
      : recommendationDiagnostics?.aggressiveSpreadPctDisplay;
  const diagDistance =
    legKey === "safe"
      ? recommendationDiagnostics?.safeDistancePct
      : recommendationDiagnostics?.aggressiveDistancePctDisplay;
  const diagPop = legKey === "safe" ? mainPop : recommendationDiagnostics?.aggressivePop;

  return (
    <div className={cn("rounded-2xl border bg-white p-4 shadow-sm", selectedBorder, className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">{title}</p>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {isSelected && (
            <Badge className={cn(
              "rounded-full text-xs",
              selectedGrade === "WATCH"
                ? "border border-amber-300 bg-amber-50 text-amber-800"
                : "border border-emerald-300 bg-emerald-50 text-emerald-800"
            )}>
              Sélectionné{selectedGrade ? ` [${selectedGrade}]` : ""}
            </Badge>
          )}
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
        <Metric label="Strike" value={hasStrikeNumber ? `$${strikeNumber.toFixed(2)}` : "non disponible"} strong />
        <Metric
          label={premiumLabel || "Prime (mid)"}
          value={Number.isFinite(displayedPremium) ? `$${displayedPremium.toFixed(2)}` : "—"}
          strong={displayedPremium != null && displayedPremium >= 0.09}
          tone={premiumTone}
        />
        <Metric
          label="Distance"
          value={hasDistanceNumber ? `${distanceNumber.toFixed(1)}%` : "non disponible"}
          strong
          tone={distanceTone}
        />
        <Metric
          label="Rendement période"
          value={
            yieldOk ? `${tradeYieldNumber.toFixed(2)}%` : "—"
          }
          strong
          tone={yieldTone}
        />
        <Metric
          label="Rendement normalisé 7J"
          value={
            Number.isFinite(weeklyNormalizedYieldNumber)
              ? `${weeklyNormalizedYieldNumber.toFixed(2)}%`
              : "—"
          }
          strong
          tone={yieldTone}
        />
        <Metric
          label="Annualisé estimé"
          value={
            Number.isFinite(annualizedYieldNumber)
              ? `${annualizedYieldNumber.toFixed(1)}%`
              : "—"
          }
          tone={yieldTone}
        />
        <Metric
          label="DTE"
          value={Number.isFinite(Number(dteDays)) ? `${Number(dteDays)} jours` : "—"}
        />
        <Metric
          label="POP profit estimée"
          value={Number.isFinite(mainPopNumber) ? `${(mainPopNumber * 100).toFixed(1)}%` : "—"}
          tone={popTone}
        />
        <Metric
          label="POP OTM estimée"
          value={Number.isFinite(popOtmEstimatedNumber) ? `${(popOtmEstimatedNumber * 100).toFixed(1)}%` : "—"}
          tone={
            !Number.isFinite(popOtmEstimatedNumber)
              ? "default"
              : popOtmEstimatedNumber >= 0.7
              ? "good"
              : "warn"
          }
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

      <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600">
        <span className="font-semibold text-slate-700">Diag reco</span>
        {` • grade ${diagGrade ?? "—"}`}
        {` • yld ${Number.isFinite(Number(diagYield)) ? `${Number(diagYield).toFixed(2)}%` : "—"}`}
        {` • spread ${Number.isFinite(Number(diagSpread)) ? `${Number(diagSpread).toFixed(1)}%` : "—"}`}
        {` • dist ${Number.isFinite(Number(diagDistance)) ? `${Number(diagDistance).toFixed(1)}%` : "—"}`}
        {` • POP ${Number.isFinite(Number(diagPop)) ? `${(Number(diagPop) * 100).toFixed(1)}%` : "—"}`}
        {` • reco ${recommendedMode ?? "—"}${recommendedGrade ? ` [${recommendedGrade}]` : ""}`}
      </div>
    </div>
  );
}

function StrikeOpportunities({ item }) {
  const { finalDisplayMode, finalDisplayGrade } = getFinalDisplayRecommendation(item);
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
              dteDays={item.safeStrike.dteDays ?? item.dteDays}
              distancePct={item.safeStrike.distancePct}
              label={item.safeStrike.label}
              meetsTarget={
                Number.isFinite(Number(item.safeStrike.mid)) &&
                Number(item.safeStrike.mid) >= Number(item.minPremium || 0)
              }
              liquidity={item.safeStrike.liquidity}
              isSelected={finalDisplayMode === "SAFE"}
              selectedGrade={finalDisplayMode === "SAFE" ? finalDisplayGrade : null}
              recommendedMode={finalDisplayMode}
              recommendedGrade={finalDisplayGrade}
              recommendationDiagnostics={item.recommendationDiagnostics}
              legKey="safe"
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
              dteDays={item.aggressiveStrike.dteDays ?? item.dteDays}
              distancePct={item.aggressiveStrike.distancePct}
              label={item.aggressiveStrike.label}
              meetsTarget={
                Number.isFinite(Number(item.aggressiveStrike.mid)) &&
                Number(item.aggressiveStrike.mid) >= Number(item.minPremium || 0)
              }
              liquidity={item.aggressiveStrike.liquidity}
              isSelected={finalDisplayMode === "AGGRESSIVE"}
              selectedGrade={finalDisplayMode === "AGGRESSIVE" ? finalDisplayGrade : null}
              recommendedMode={finalDisplayMode}
              recommendedGrade={finalDisplayGrade}
              recommendationDiagnostics={item.recommendationDiagnostics}
              legKey="aggressive"
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

function FaceplateStrikeOpportunities({ item }) {
  const hasSafe = !!item.safeStrike;
  const hasAggressive = !!item.aggressiveStrike;
  const { finalDisplayMode, finalDisplayGrade } = getFinalDisplayRecommendation(item);
  const safeSelected = finalDisplayMode === "SAFE";
  const aggressiveSelected = finalDisplayMode === "AGGRESSIVE";
  const safeDebug = `safeRank=${item.safeRank ?? item.recommendationDiagnostics?.safeRank ?? "—"} • finalRank=${item.finalRank ?? item.recommendationDiagnostics?.finalRank ?? "—"}`;
  const aggressiveDebug = `aggressiveRank=${item.aggressiveRank ?? item.recommendationDiagnostics?.aggressiveRank ?? "—"} • finalRank=${item.finalRank ?? item.recommendationDiagnostics?.finalRank ?? "—"}`;

  return (
    <div className="h-full">
      {hasSafe || hasAggressive ? (
        <div className="grid h-full grid-cols-1 items-stretch gap-3 md:grid-cols-2 xl:grid-cols-2">
          <FaceplateStrikeColumn
            title="Safe (IBKR live)"
            tone="safe"
            strikeData={item.safeStrike}
            fallbackDte={item.dteDays}
            isSelected={safeSelected}
            selectedGrade={safeSelected ? finalDisplayGrade : null}
            selectedMode={finalDisplayMode}
            displayGrade={finalDisplayGrade}
            debugLabel={safeDebug}
          />
          <FaceplateStrikeColumn
            title="Aggressif (IBKR live)"
            tone="aggressive"
            strikeData={item.aggressiveStrike}
            fallbackDte={item.dteDays}
            isSelected={aggressiveSelected}
            selectedGrade={aggressiveSelected ? finalDisplayGrade : null}
            selectedMode={finalDisplayMode}
            displayGrade={finalDisplayGrade}
            debugLabel={aggressiveDebug}
          />
        </div>
      ) : (
        <div className="rounded-[8px] border border-dashed border-slate-700 bg-slate-950 p-4 text-sm text-slate-400">
          Aucun strike local disponible.
        </div>
      )}
    </div>
  );
}

function SupportStatusLine({ item }) {
  if (item.strikeVsSupportPct == null) {
    return (
      <div className="rounded-[7px] border border-[#172637] bg-[#06111b]/95 px-3 py-2 text-sm text-slate-300">
        Support: indisponible
      </div>
    );
  }

  const toneClass =
    item.supportStatus === "strike_below_support" || item.supportStatus === "below_support"
      ? "border-[#0b4a66] bg-cyan-950/35 text-[#00c8ff] shadow-[0_0_18px_rgba(0,200,255,0.08)]"
      : item.supportStatus === "strike_near_support" || item.supportStatus === "near_support"
      ? "border-[#6a4300] bg-amber-950/35 text-[#ffb21a] shadow-[0_0_18px_rgba(255,176,0,0.08)]"
      : item.supportStatus === "strike_above_support" || item.supportStatus === "room_above_support"
      ? "border-[#601824] bg-rose-950/35 text-[#ff273a] shadow-[0_0_18px_rgba(255,39,58,0.08)]"
      : "border-[#601824] bg-rose-950/35 text-[#ff273a] shadow-[0_0_18px_rgba(255,39,58,0.08)]";

  const label =
    item.supportStatus === "current_below_support"
      ? "prix sous support"
      : item.supportStatus === "strike_above_support" || item.supportStatus === "room_above_support"
      ? "strike au-dessus du support"
      : item.supportStatus === "strike_near_support" || item.supportStatus === "near_support"
      ? "strike proche du support"
      : "strike sous support — marge de sécurité";

  return (
    <div className={cn("rounded-[7px] border px-3 py-2 text-sm font-semibold", toneClass)}>
      Strike vs support: {label} ({Math.abs(item.strikeVsSupportPct).toFixed(1)}% {item.strikeVsSupportPct < 0 ? "sous" : "au-dessus du"} support)
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

function buildIbkrRetainedViewModel(item) {
  const spot = Number(item?.currentPrice ?? item?.underlyingPrice ?? 0);
  const resolvedDte = Number.isFinite(Number(item?.dteDays)) ? Number(item.dteDays) : null;
  const safeStrike = ibkrStrikeToDashboardStrike(
    item?.safeStrike,
    spot,
    "safe IBKR live",
    false,
    resolvedDte
  );
  const aggressiveStrike = ibkrStrikeToDashboardStrike(
    item?.aggressiveStrike,
    spot,
    "agressif IBKR live",
    false,
    resolvedDte
  );
  const modeRecommendation = computeModeRecommendation({
    safeStrike,
    aggressiveStrike,
    lowerBound: item?.lowerBound ?? null,
    spot,
    hasUpcomingEarningsBeforeExpiration: item?.hasUpcomingEarningsBeforeExpiration ?? false,
    hasEarningsBeforeExpiration: item?.hasEarningsBeforeExpiration ?? false,
    earningsDaysUntil: item?.earningsDaysUntil ?? null,
  });
  const finalDisplayRecommendation = getFinalDisplayRecommendation({
    safeStrike,
    aggressiveStrike,
    safeGrade: modeRecommendation.safeGrade,
    aggressiveGrade: modeRecommendation.aggressiveGrade,
    recommendedMode: modeRecommendation.recommendedMode,
    recommendedGrade: modeRecommendation.recommendedGrade,
    recommendationDiagnostics: modeRecommendation.recommendationDiagnostics,
  });
  const finalDisplayMode = finalDisplayRecommendation.finalDisplayMode;
  const finalDisplayGrade = finalDisplayRecommendation.finalDisplayGrade;
  const selectedLeg = finalDisplayMode === "AGGRESSIVE" ? aggressiveStrike : safeStrike;

  return {
    safeStrike,
    aggressiveStrike,
    finalDisplayMode,
    finalDisplayGrade,
    safeSelected: finalDisplayMode === "SAFE",
    aggressiveSelected: finalDisplayMode === "AGGRESSIVE",
    selectedLeg,
    selectedYieldPct: selectedLeg?.weeklyYield ?? null,
    selectedSpreadPct: selectedLeg?.liquidity?.spreadPct ?? null,
    selectedPremium: selectedLeg?.premiumUsed ?? selectedLeg?.mid ?? null,
  };
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

function IbkrMiniStrikeDetailsSelected({
  title,
  strike,
  isSelected = false,
  selectedGrade = null,
  selectedMode = null,
}) {
  const selectedBorder = !isSelected
    ? "border-slate-200"
    : selectedGrade === "WATCH"
    ? "border-amber-500 ring-2 ring-amber-300/55 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]"
    : "border-emerald-500 ring-2 ring-emerald-300/55 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]";
  const selectedBadgeClass = selectedGrade === "WATCH"
    ? "border border-amber-300 bg-amber-50 text-amber-900"
    : "border border-emerald-300 bg-emerald-50 text-emerald-800";
  return (
    <div className={cn("rounded-xl border bg-white/80 p-3", selectedBorder)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
          <p className="mt-1 text-sm font-semibold text-slate-900">
            Strike {formatStrikeOrDash(strike?.strike)}
          </p>
        </div>
        {isSelected && (
          <Badge className={cn("rounded-full px-2 py-0.5 text-[11px]", selectedBadgeClass)}>
            Sélectionné{selectedGrade ? ` [${selectedGrade}]` : ""}
          </Badge>
        )}
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-600">
        Bid {formatMoneyOrDash(strike?.bid)} / Ask {formatMoneyOrDash(strike?.ask)} / Mid{" "}
        {formatMoneyOrDash(strike?.mid)}
      </p>
      <p className="text-xs leading-5 text-slate-600">
        Spread {formatMoneyOrDash(strike?.spread)} / {formatIbkrPercent(strike?.spreadPct)} · Prime{" "}
        {formatMoneyOrDash(strike?.primeUsed)}
      </p>
      <p className="mt-2 text-[11px] leading-5 text-slate-500">
        {`selected=${isSelected ? "true" : "false"} • mode=${selectedMode ?? "—"} • grade=${selectedGrade ?? "—"}`}
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

function ibkrStrikeToDashboardStrike(strike, spot, label, preserveNullQuotes = false, dteDays = null) {
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
    const dte = Number(dteDays);
    weeklyNormalizedYield =
      Number.isFinite(dte) && dte > 0 ? yieldDecimal * (7 / dte) * 100 : yieldDecimal * 100;
    annualizedYield =
      Number.isFinite(dte) && dte > 0 ? yieldDecimal * (365 / dte) * 100 : yieldDecimal * 52 * 100;
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
    dteDays: Number.isFinite(Number(dteDays)) ? Number(dteDays) : null,
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
  const expirationForDte =
    normalizeExpirationYmd(selectedExpiration) ??
    normalizeExpirationYmd(yahooCandidate?.targetExpiration) ??
    normalizeExpirationYmd(yahooCandidate?.expiration) ??
    null;
  const fallbackDte = expirationForDte
    ? daysBetweenYmd(ymdTodayLocal(), expirationForDte)
    : null;
  const resolvedDteDays = resolveMergedDteDays({
    ibkrDte: ibkrCandidate?.dteDays,
    yahooDte: yahooCandidate?.dteDays,
    expirationYmd: expirationForDte,
  });
  console.log("[DTE_RESOLVE]", {
    symbol,
    expiration: expirationForDte,
    ibkrDte: ibkrCandidate?.dteDays ?? null,
    yahooDte: yahooCandidate?.dteDays ?? null,
    fallbackDte,
    resolvedDte: resolvedDteDays,
  });
  const safeStrike = ibkrStrikeToDashboardStrike(
    ibkrCandidate?.safeStrike,
    spot,
    "safe IBKR live",
    preserveNullQuotes,
    Number.isFinite(resolvedDteDays) ? resolvedDteDays : null
  );
  const aggressiveStrike = ibkrStrikeToDashboardStrike(
    ibkrCandidate?.aggressiveStrike,
    spot,
    "agressif IBKR live",
    preserveNullQuotes,
    Number.isFinite(resolvedDteDays) ? resolvedDteDays : null
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
  const resolvedLowerBound = ibkrCandidate?.lowerBound ?? yahooCandidate?.expectedMoveLow ?? null;
  const modeRecommendation = computeModeRecommendation({
    safeStrike: safeStrikeWithPop,
    aggressiveStrike: aggressiveStrikeWithPop,
    lowerBound: resolvedLowerBound,
    spot,
    hasUpcomingEarningsBeforeExpiration:
      yahooCandidate?.hasUpcomingEarningsBeforeExpiration ?? false,
    hasEarningsBeforeExpiration:
      yahooCandidate?.hasEarningsBeforeExpiration ?? false,
    earningsDaysUntil: yahooCandidate?.earningsDaysUntil ?? null,
  });
  const finalDisplayRecommendation = getFinalDisplayRecommendation({
    safeStrike: safeStrikeWithPop,
    aggressiveStrike: aggressiveStrikeWithPop,
    safeGrade: modeRecommendation.safeGrade,
    aggressiveGrade: modeRecommendation.aggressiveGrade,
    recommendedMode: modeRecommendation.recommendedMode,
    recommendedGrade: modeRecommendation.recommendedGrade,
    recommendationDiagnostics: modeRecommendation.recommendationDiagnostics,
  });
  const ftqs = computeFinalTradeQualityScore({
    symbol,
    safeStrike: safeStrikeWithPop,
    aggressiveStrike: aggressiveStrikeWithPop,
    lowerBound: resolvedLowerBound,
    spot,
    dteDays: resolvedDteDays,
    minPremium: ibkrCandidate?.targetPremium ?? yahooCandidate?.minPremium ?? null,
    recommendedMode: modeRecommendation.recommendedMode,
    aggressiveOpportunityScore: modeRecommendation.aggressiveOpportunityScore,
    hasUpcomingEarningsBeforeExpiration:
      yahooCandidate?.hasUpcomingEarningsBeforeExpiration ?? false,
    hasEarningsBeforeExpiration:
      yahooCandidate?.hasEarningsBeforeExpiration ?? false,
    earningsDaysUntil: yahooCandidate?.earningsDaysUntil ?? null,
    eliteScore: ibkrCandidate?.eliteScore ?? null,
  });
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
  console.log("[FTQS_DIAG]", ftqs.logPayload);

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
    expectedMoveLow: resolvedLowerBound ?? 0,
    expectedMoveHigh: ibkrCandidate?.upperBound ?? yahooCandidate?.expectedMoveHigh ?? 0,
    minPremium: ibkrCandidate?.targetPremium ?? yahooCandidate?.minPremium ?? minPremiumForSpot(spot),
    targetWeeks: yahooCandidate?.targetWeeks ?? 1,
    dteDays: Number.isFinite(resolvedDteDays) ? resolvedDteDays : null,
    safeStrike: safeStrikeWithPop,
    aggressiveStrike: aggressiveStrikeWithPop,
    safeScore: modeRecommendation.safeScore,
    aggressiveOpportunityScore: modeRecommendation.aggressiveOpportunityScore,
    safeGrade: modeRecommendation.safeGrade,
    aggressiveGrade: modeRecommendation.aggressiveGrade,
    safeRank: finalDisplayRecommendation.safeRank,
    aggressiveRank: finalDisplayRecommendation.aggressiveRank,
    finalRank: finalDisplayRecommendation.finalRank,
    recommendedMode: modeRecommendation.recommendedMode,
    recommendedGrade: modeRecommendation.recommendedGrade,
    finalDisplayMode: finalDisplayRecommendation.finalDisplayMode,
    finalDisplayGrade: finalDisplayRecommendation.finalDisplayGrade,
    recommendedReason: modeRecommendation.recommendedReason,
    recommendationDiagnostics: modeRecommendation.recommendationDiagnostics,
    finalTradeQualityScore: ftqs.finalTradeQualityScore,
    finalTradeQualityBreakdown: ftqs.finalTradeQualityBreakdown,
    premium: premiumLabel,
    weeklyReturn: weeklyReturnValue,
    strikeDistance: primaryStrike ? primaryStrike.distancePct : yahooCandidate?.strikeDistance ?? 0,
    proFinalScore: yahooCandidate?.proFinalScore ?? 0,
    proExecutionScore: yahooCandidate?.proExecutionScore ?? 0,
    proDistanceScore: yahooCandidate?.proDistanceScore ?? 0,
    scoreSource: yahooCandidate?.scoreSource ?? "ibkr_fallback",
    tier: yahooCandidate?.tier ?? "none",
    qualityScore: yahooCandidate?.qualityScore ?? null,
    eliteScore: Number.isFinite(Number(ibkrCandidate?.eliteScore)) ? Number(ibkrCandidate.eliteScore) : null,
    eliteBadge: ibkrCandidate?.eliteBadge ?? null,
    yahooRank:
      Number.isFinite(Number(yahooCandidate?.rank)) ? Number(yahooCandidate.rank) : null,
    ibkrRank:
      Number.isFinite(Number(ibkrCandidate?.ibkrRank)) ? Number(ibkrCandidate.ibkrRank) : index + 1,
    scoreBreakdown:
      ibkrCandidate?.scoreBreakdown && typeof ibkrCandidate.scoreBreakdown === "object"
        ? ibkrCandidate.scoreBreakdown
        : null,
    strengths: Array.isArray(ibkrCandidate?.strengths) ? ibkrCandidate.strengths : [],
    weaknesses: Array.isArray(ibkrCandidate?.weaknesses) ? ibkrCandidate.weaknesses : [],
    qualityReasons: [...new Set([...yahooQualityReasons, ...ibkrQualityReasons].filter(Boolean))],
    diagnosticsV12:
      yahooCandidate?.diagnosticsV12 && typeof yahooCandidate.diagnosticsV12 === "object"
        ? { ...yahooCandidate.diagnosticsV12 }
        : ibkrCandidate?.diagnosticsV12 && typeof ibkrCandidate.diagnosticsV12 === "object"
        ? { ...ibkrCandidate.diagnosticsV12 }
        : null,
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
    supportWide: yahooCandidate?.supportWide ?? yahooCandidate?.support ?? null,
    supportNear: yahooCandidate?.supportNear ?? null,
    potentialSupportFromBrokenResistance:
      yahooCandidate?.potentialSupportFromBrokenResistance ?? null,
    resistanceAboveSpot: yahooCandidate?.resistanceAboveSpot ?? null,
    resistanceCurrent: yahooCandidate?.resistanceCurrent ?? yahooCandidate?.resistance ?? null,
    resistanceStatus: yahooCandidate?.resistanceStatus ?? "unavailable",
    supportResistanceMethod: yahooCandidate?.supportResistanceMethod ?? null,
    supportResistance: yahooCandidate?.supportResistance ?? null,
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
            {Number.isFinite(Number(item.eliteScore)) && (
              <Badge className={cn("rounded-full border", classifyEliteBadge(item.eliteBadge))}>
                Elite {Number(item.eliteScore).toFixed(1)} · {item.eliteBadge || "Speculative"}
              </Badge>
            )}
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

function CandidateCard({ item, displayRank, yahooRankForIbkr, onOpenDetail, ibkrBatchRow = null, seasonality = null, highlightedTicker = null }) {
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
  const supportWideRaw = item.supportWide ?? item.support;
  const supportNearRaw = item.supportNear;
  const potentialSupportRaw = item.potentialSupportFromBrokenResistance;
  const resistanceRaw = item.resistanceCurrent ?? item.resistance;
  const resistanceAboveSpotRaw = item.resistanceAboveSpot;
  const supportWideValue = isValidLevel(supportWideRaw) ? Number(supportWideRaw) : null;
  const supportNearValue = isValidLevel(supportNearRaw) ? Number(supportNearRaw) : null;
  const potentialSupportValue = isValidLevel(potentialSupportRaw) ? Number(potentialSupportRaw) : null;
  const resistanceValue = isValidLevel(resistanceRaw) ? Number(resistanceRaw) : null;
  const resistanceAboveSpotValue = isValidLevel(resistanceAboveSpotRaw) ? Number(resistanceAboveSpotRaw) : null;
  const priceValue = Number(item.price);
  const resistanceUnderSpot =
    isValidLevel(resistanceValue) &&
    Number.isFinite(priceValue) &&
    resistanceValue < priceValue;
  const resistanceDistancePct =
    isValidLevel(resistanceValue) &&
    Number.isFinite(priceValue) &&
    priceValue > 0
      ? ((resistanceValue - priceValue) / priceValue) * 100
      : null;
  const resistanceAbovePct =
    isValidLevel(resistanceValue) &&
    Number.isFinite(priceValue) &&
    resistanceValue > 0
      ? ((priceValue - resistanceValue) / resistanceValue) * 100
      : null;
  const supportWideDisplay =
    !isValidLevel(supportWideValue) ? "non disponible" : `$${supportWideValue.toFixed(2)}`;
  const supportNearDisplay =
    !isValidLevel(supportNearValue) ? "non disponible" : `$${supportNearValue.toFixed(2)}`;
  const fallbackPotentialSupportValue =
    !isValidLevel(potentialSupportValue) &&
    item.resistanceStatus === "broken" &&
    isValidLevel(resistanceValue)
      ? resistanceValue
      : potentialSupportValue;
  const potentialSupportDisplay =
    !isValidLevel(fallbackPotentialSupportValue)
      ? "non disponible"
      : `$${fallbackPotentialSupportValue.toFixed(2)}`;
  const resistanceAboveSpotDisplay =
    !isValidLevel(resistanceAboveSpotValue) ? "non disponible" : `$${resistanceAboveSpotValue.toFixed(2)}`;
  const resistanceDisplay =
    !isValidLevel(resistanceValue)
      ? "—"
      : `$${resistanceValue.toFixed(2)}`;
  const resistanceStatusDisplay =
    !isValidLevel(resistanceValue)
      ? "—"
      : item.resistanceStatus === "broken"
      ? "franchie"
      : item.resistanceStatus === "above"
      ? "au-dessus"
      : resistanceUnderSpot
      ? "franchie"
      : "à surveiller";
  const resistanceDistanceDisplay =
    resistanceDistancePct == null
      ? "—"
      : resistanceDistancePct >= 0
      ? `${resistanceDistancePct.toFixed(1)} %`
      : `+${Math.abs(resistanceDistancePct).toFixed(1)} % au-dessus`;
  const ibkrSpreadClass = classifySpreadPctPercent(item.ibkrSpreadPct);
  const hasIbkrSpread = normalizedIbkrSpreadPctPercent(item.ibkrSpreadPct) != null;
  const ibkrActionability = getIbkrActionabilityStatus(item);
  const { finalDisplayMode, finalDisplayGrade } = getFinalDisplayRecommendation(item);
  const tickerMeta = getTickerDisplayMeta(item.ticker);
  const tierStyle = QUALITY_TIER_STYLE[tickerMeta.qualityTier] ?? QUALITY_TIER_STYLE["Inconnu à valider"];
  const resolvedName =
    tickerMeta.name ??
    item.companyName ??
    item.longName ??
    item.shortName ??
    (item.name !== item.ticker ? item.name : null) ??
    null;
  const displayLeg = finalDisplayMode === "AGGRESSIVE" ? item.aggressiveStrike : item.safeStrike;
  const displayYield = (displayLeg?.weeklyYield != null && Number(displayLeg.weeklyYield) > 0)
    ? Number(displayLeg.weeklyYield)
    : (item.weeklyReturn != null && Number(item.weeklyReturn) > 0 ? Number(item.weeklyReturn) : null);
  const displayDistance = displayLeg?.distancePct ?? item.strikeDistance;
  const isTickerHighlighted = highlightedTicker === String(item?.ticker || "").trim().toUpperCase();

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      data-ticker-card={String(item?.ticker || "").trim().toUpperCase()}
      className="scroll-mt-24"
    >
      <Card className={cn(
        "rounded-[8px] border-[#172637] bg-[#020811] text-slate-100 shadow-[0_0_0_1px_rgba(80,140,180,0.08),0_24px_80px_rgba(0,0,0,0.34)] transition-all hover:shadow-[0_0_0_1px_rgba(80,140,180,0.14),0_28px_90px_rgba(0,0,0,0.42)]",
        isTickerHighlighted && "ring-2 ring-sky-400 ring-offset-2 ring-offset-slate-50 shadow-[0_0_0_1px_rgba(56,189,248,0.55),0_0_28px_rgba(56,189,248,0.35)]"
      )}>
        <CardContent className="p-2">
          <div className="space-y-1">
            <div className="space-y-0.5">
              {/* Ligne 1 : Ticker gauche | badges centre | bouton droite */}
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-shrink">
                  <h3 className="flex items-baseline gap-1 text-base font-semibold tracking-tight leading-tight text-white min-w-0">
                    <span className="shrink-0">
                      {item.ticker}
                      {tickerMeta.isFavorite && (
                        <span className="ml-1.5 text-amber-400 text-sm" title="Favori">&#9733;</span>
                      )}
                    </span>
                    <span className="font-normal text-slate-300 truncate min-w-0">
                      {resolvedName ?? <span className="text-slate-500 italic">Nom indisponible</span>}
                    </span>
                  </h3>
                  {/* Ligne méta : type · secteur */}
                  <p className="text-[11px] leading-tight text-slate-500 mt-0.5 truncate">
                    {tickerMeta.type && <span className="text-slate-400">{tickerMeta.type}</span>}
                    {tickerMeta.type && tickerMeta.sector && <span className="mx-1 text-slate-600">·</span>}
                    {tickerMeta.sector && <span>{tickerMeta.sector}</span>}
                    {!tickerMeta.type && !tickerMeta.sector && (
                      <span className="italic">secteur non renseigné</span>
                    )}
                  </p>
                </div>
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                  {/* Badge qualité ticker */}
                  <Badge className={cn("rounded-[4px] border px-2 py-0.5 text-[11px] font-medium", tierStyle.badge)}>
                    {tickerMeta.qualityTier}
                  </Badge>
                  <Badge className="rounded-[6px] border border-[#26384b] bg-[#07111b] px-2 py-0.5 text-xs text-slate-100">
                    Choix #{shownRank}
                  </Badge>
                  {yahooRank != null && (
                    <Badge className="rounded-[6px] border border-[#26384b] bg-[#07111b] px-2 py-0.5 text-xs text-slate-100">
                      Rang Yahoo #{yahooRank}
                    </Badge>
                  )}
                  <Badge className={cn("rounded-[4px] border px-2 py-0.5 text-xs", verdictStyle[item.verdict])}>
                    {item.verdict}
                  </Badge>
                  {item.earningsMode && (
                    <Badge className="rounded-[4px] border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs text-violet-700">
                      mode earnings x{item.expectedMoveMultiplier || 2}
                    </Badge>
                  )}
                  {item.ok && !item.ibkrDevObjectiveBlocked ? (
                    <Badge className="rounded-[4px] border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                      objectif validé
                    </Badge>
                  ) : (
                    <Badge className="rounded-[4px] border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">
                      à surveiller
                    </Badge>
                  )}
                  {item.optionsSource === "IBKR live" && (
                    <Badge className="rounded-[4px] border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700">
                      Technique : {techniqueBadgeLabel(item)}
                    </Badge>
                  )}
                  {item.optionsSource === "IBKR live" && (
                    <Badge className="rounded-[4px] border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700">
                      Options : IBKR live
                    </Badge>
                  )}
                  {item.optionsSource === "IBKR live" && (
                    <Badge className={cn("rounded-[4px] border px-2 py-0.5 text-xs", ibkrActionability.className)}>
                      {ibkrActionability.label}
                    </Badge>
                  )}
                  {seasonality?.seasonalBias && (
                    <SeasonalityBadge
                      bias={seasonality.seasonalBias}
                      score={seasonality.seasonalityScore ?? null}
                    />
                  )}
                </div>
                <Button
                  className="shrink-0 rounded-[6px] border border-slate-600 bg-[#07111b] px-3 py-1 text-sm text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                  onClick={() => onOpenDetail(item)}
                >
                  Voir fiche complète ↗
                </Button>
              </div>

              {/* Ligne 2 : sous-titre setup */}
              <p className="text-xs text-slate-400 leading-tight">{item.setup}</p>

              {/* Ligne 3 : mode recommandé + grade */}
              {finalDisplayMode === "REJECT" ? (
                <p className="text-xs text-rose-400 leading-tight">
                  Mode : <span className="font-semibold">REJECT</span> — {item.recommendedReason}
                </p>
              ) : finalDisplayGrade === "WATCH" ? (
                <p className="text-xs text-amber-300 leading-tight">
                  Mode : <span className="font-semibold">{finalDisplayMode}</span>{" "}
                  <span className="text-amber-400">[WATCH]</span> — {item.recommendedReason}
                </p>
              ) : finalDisplayMode === "AGGRESSIVE" ? (
                <p className="text-xs text-emerald-300 leading-tight">
                  Mode : <span className="font-semibold">AGGRESSIVE</span>
                  {finalDisplayGrade ? ` [${finalDisplayGrade}]` : ""} — {item.recommendedReason}
                </p>
              ) : (
                <p className="text-xs text-emerald-400 leading-tight">
                  Mode : <span className="font-semibold">SAFE</span>
                  {finalDisplayGrade ? ` [${finalDisplayGrade}]` : ""}
                  {item.recommendedReason && item.recommendedReason !== "SAFE — meilleur compromis risque/liquidité" ? ` — ${item.recommendedReason}` : ""}
                </p>
              )}

              {item.ticker === "APLD" && (
                <p className="text-[11px] leading-tight text-sky-300">
                  APLD debug • safeGrade {item.safeGrade ?? "—"} • aggressiveGrade {item.aggressiveGrade ?? "—"} • safeRank {item.safeRank ?? item.recommendationDiagnostics?.safeRank ?? "—"} • aggressiveRank {item.aggressiveRank ?? item.recommendationDiagnostics?.aggressiveRank ?? "—"} • finalRank {item.finalRank ?? item.recommendationDiagnostics?.finalRank ?? "—"} • finalDisplayMode {item.finalDisplayMode ?? finalDisplayMode ?? "—"} • finalDisplayGrade {item.finalDisplayGrade ?? finalDisplayGrade ?? "—"}
                </p>
              )}
              {/* Earnings si présent */}
              {earningsDisplay ? (
                <p className="text-xs text-amber-300 leading-tight">{earningsDisplay}</p>
              ) : relevantEarningsDate ? (
                <p className="text-xs text-violet-300 leading-tight">
                  Earnings: {formatShortDate(relevantEarningsDate) || relevantEarningsDate}
                </p>
              ) : null}

              {/* DEV TEST / Données incomplètes — ligne séparée centrée */}
              {(item.ibkrDirect?.devScanEnabled || (item.indicativeShortlistSession && !item.ibkrDirect?.devScanEnabled) || item.ibkrDevIncompleteSurface) && (
                <div className="flex justify-center gap-1">
                  {item.ibkrDirect?.devScanEnabled && (
                    <Badge className="rounded-[4px] border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs text-amber-950">
                      DEV TEST — données hors marché / non tradables
                    </Badge>
                  )}
                  {item.indicativeShortlistSession && !item.ibkrDirect?.devScanEnabled && (
                    <Badge className="rounded-[4px] border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs text-amber-950">
                      DEV TEST — marche ferme / donnees indicatives / non tradables
                    </Badge>
                  )}
                  {item.ibkrDevIncompleteSurface && (
                    <Badge className="rounded-[4px] border border-amber-300 bg-amber-100 px-2 py-0.5 text-xs text-amber-950">
                      Données IBKR incomplètes — affichage DEV seulement
                    </Badge>
                  )}
                </div>
              )}

              <div className="grid grid-cols-2 gap-1.5 text-sm md:grid-cols-4 xl:grid-cols-8 2xl:grid-cols-[1.02fr_1.05fr_1.14fr_1.14fr_0.86fr_0.76fr_0.72fr_1fr]">
                <FaceplateMetric label="Prix actuel" value={`$${item.price.toFixed(2)}`} strong />
                <FaceplateMetric
                  label="Mouvement attendu"
                  value={
                    item.earningsMode
                      ? `${item.expectedMovePct.toFixed(2)}% -> ${adjustedMovePct.toFixed(2)}%`
                      : `${item.expectedMovePct.toFixed(2)}%`
                  }
                  strong
                  tone={item.earningsMode ? "bad" : "orange"}
                />
                <FaceplateMetric
                  label="Plage attendue"
                  value={`$${item.expectedMoveLow.toFixed(2)} - $${item.expectedMoveHigh.toFixed(2)}`}
                  strong
                  tone="bad"
                />
                <FaceplateMetric
                  label={`Rendement${finalDisplayMode === "AGGRESSIVE" ? " (agressif)" : ""}`}
                  value={displayYield != null ? `${displayYield.toFixed(2)}%` : "—"}
                  sub={displayYield != null ? "jusqu'à expiration" : null}
                  strong={displayYield != null && displayYield >= 0.5}
                  tone={displayYield == null ? "default" : displayYield >= 0.5 ? "good" : "bad"}
                />
                <FaceplateMetric label="Distance strike" value={Number.isFinite(Number(displayDistance)) ? `${Number(displayDistance).toFixed(1)}%` : "—"} />
                <FaceplateMetric label="Sem. cible" value={`${item.targetWeeks ?? 1}`} />
                <FaceplateMetric
                  label="DTE"
                  value={Number.isFinite(Number(item?.dteDays)) ? `${Number(item.dteDays)} jours` : "—"}
                  strong
                />
                <FaceplateMetric label="Capital / contrat" value={`$${item.capitalPerContract.toFixed(0)}`} />
              </div>

              <div className="grid gap-3 xl:grid-cols-[minmax(0,2.22fr)_minmax(390px,0.98fr)]">
                <MiniTradeLevelsChart item={item} />
                <FaceplateStrikeOpportunities item={item} />
              </div>

              <div className="rounded-[8px] border border-[#132536] bg-[#020811]/95 p-2.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_22px_rgba(0,170,255,0.025)]">
                <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-3 xl:grid-cols-9">
                  <FaceplateMetric label="IV" value={typeof item.iv === "number" ? `${item.iv.toFixed(1)}%` : "—"} />
                  <FaceplateMetric
                    label="RSI"
                    value={typeof item.rsi === "number" ? `${item.rsi}` : "—"}
                    strong={typeof item.rsi === "number"}
                    tone={typeof item.rsi !== "number" ? "default" : item.rsi >= 70 ? "bad" : item.rsi <= 40 ? "orange" : "good"}
                  />
                  <FaceplateMetric label="Trend" value={item.trend || "unknown"} strong tone={item.trend === "bullish" ? "good" : item.trend === "bearish" ? "bad" : "orange"} />
                  <FaceplateMetric label="Momentum" value={item.momentum || "unknown"} strong tone={item.momentum === "positive" ? "good" : item.momentum === "negative" ? "bad" : "orange"} />
                  <FaceplateMetric label="Support proche" value={supportNearDisplay} tone="good" />
                  <FaceplateMetric label="Résistance actuelle" value={resistanceDisplay} tone={resistanceStatusDisplay === "franchie" ? "warn" : "default"} />
                  <FaceplateMetric label="Résistance sup." value={resistanceAboveSpotDisplay} tone="warn" />
                  <FaceplateMetric
                    label="Score Yahoo"
                    value={item.qualityScore != null ? `${item.qualityScore} pts` : "—"}
                    strong={item.qualityScore != null}
                    tone={item.qualityScore == null ? "default" : item.qualityScore >= 50 ? "good" : item.qualityScore >= 20 ? "orange" : "bad"}
                  />
                  <FaceplateMetric
                    label="Elite Score"
                    value={Number.isFinite(Number(item.eliteScore)) ? `${Number(item.eliteScore).toFixed(1)} / 100` : "—"}
                    strong={Number.isFinite(Number(item.eliteScore))}
                    tone={!Number.isFinite(Number(item.eliteScore)) ? "default" : Number(item.eliteScore) >= 82 ? "good" : Number(item.eliteScore) >= 68 ? "orange" : "bad"}
                  />
                </div>
              </div>

              <div className="grid gap-2 xl:grid-cols-3">
                {(item.resistanceStatus === "broken" || resistanceUnderSpot) &&
    isValidLevel(resistanceValue) &&
                  Number.isFinite(priceValue) && (
                  <div className="rounded-[7px] border border-[#0b4a66] bg-cyan-950/35 px-3 py-2 text-sm font-semibold text-[#00c8ff] shadow-[0_0_18px_rgba(0,200,255,0.08)]">
                    Ancienne résistance ${resistanceValue.toFixed(2)} franchie — support potentiel.
                  </div>
                )}
                {rsiHigh && (
                  <div className="rounded-[7px] border border-[#6a4300] bg-amber-950/35 px-3 py-2 text-sm font-semibold text-[#ffb21a] shadow-[0_0_18px_rgba(255,176,0,0.08)]">
                    RSI élevé : surachat court terme
                  </div>
                )}
                <SupportStatusLine item={item} />
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                {item.optionsSource === "IBKR live" && (
                  <details className="rounded-[7px] border border-[#172637] bg-[#06101a]/95 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_20px_rgba(0,170,255,0.025)]">
                    <summary className="flex cursor-pointer list-none items-center gap-3 font-semibold uppercase tracking-wide text-emerald-50 after:ml-auto after:text-xl after:leading-none after:text-slate-100 after:content-['›'] [&::-webkit-details-marker]:hidden">Options IBKR live utilisées dans cette carte</summary>
                    <div className="mt-2 leading-5">
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
                  </details>
                )}

                <details className="rounded-[7px] border border-[#172637] bg-[#06101a]/95 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_20px_rgba(0,170,255,0.025)]">
                  <summary className="flex cursor-pointer list-none items-center gap-3 font-semibold uppercase tracking-wide text-white after:ml-auto after:text-xl after:leading-none after:text-slate-100 after:content-['›'] [&::-webkit-details-marker]:hidden">Détails techniques / pipeline (score pré-IBKR, rangs, etc.)</summary>
                  {item.qualityReasons?.length > 0 ? (
                    <p className="mt-2 leading-5">
                      Score Yahoo pré-IBKR : {item.qualityReasons.join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-xs text-slate-400">
                      Détail disponible : raisons qualitatives seulement, pas de pondération chiffrée retournée.
                    </p>
                  )}
                </details>
              </div>

              <div className="grid gap-3 xl:grid-cols-2">
                <details className="rounded-[7px] border border-[#172637] bg-[#06101a]/95 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_20px_rgba(0,170,255,0.025)]">
                  <summary className="flex cursor-pointer list-none items-center gap-3 font-semibold uppercase tracking-wide text-white after:ml-auto after:text-xl after:leading-none after:text-slate-100 after:content-['›'] [&::-webkit-details-marker]:hidden">Forces / Faiblesses principales</summary>
                  {item.strengths?.length > 0 ? (
                    <p className="mt-2">
                      <span className="font-semibold text-emerald-300">Forces :</span> {item.strengths.join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-2 text-slate-400">Forces : non disponibles.</p>
                  )}
                  {item.weaknesses?.length > 0 ? (
                    <p className="mt-1">
                      <span className="font-semibold text-rose-300">Faiblesses :</span> {item.weaknesses.join(" · ")}
                    </p>
                  ) : (
                    <p className="mt-1 text-slate-400">Faiblesses : non disponibles.</p>
                  )}
                </details>

                <details className="rounded-[7px] border border-[#172637] bg-[#06101a]/95 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_20px_rgba(0,170,255,0.025)]">
                  <summary className="flex cursor-pointer list-none items-center gap-3 font-semibold uppercase tracking-wide text-white after:ml-auto after:text-xl after:leading-none after:text-slate-100 after:content-['›'] [&::-webkit-details-marker]:hidden">Métriques complémentaires (supports larges, secteur, liquidité, etc.)</summary>
                  <div className="mt-3 space-y-2">
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                      <FaceplateMetric label="Prime safe mini" value={`$${Number(item.minPremium || 0).toFixed(2)}`} />
                      <FaceplateMetric label="Support large" value={supportWideDisplay} />
                      <FaceplateMetric label="Support potentiel" value={potentialSupportDisplay} tone={item.resistanceStatus === "broken" || isValidLevel(fallbackPotentialSupportValue) ? "good" : "default"} />
                      <FaceplateMetric label="Delta Yahoo -> Elite" value={Number.isFinite(Number(item.yahooRank)) && Number.isFinite(Number(item.ibkrRank)) ? `${Number(item.yahooRank) - Number(item.ibkrRank)}` : "—"} />
                      <div className="rounded-xl border border-slate-800 bg-slate-950/80 px-3 py-2">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">Badge Elite</p>
                        <Badge className={cn("mt-1 rounded-full border", classifyEliteBadge(item.eliteBadge))}>
                          {item.eliteBadge || "Speculative"}
                        </Badge>
                      </div>
                      <FaceplateMetric label="Statut résistance" value={resistanceStatusDisplay} />
                    </div>
                    {(item.resistanceStatus === "broken" || resistanceUnderSpot) &&
    isValidLevel(resistanceValue) &&
                      Number.isFinite(priceValue) && (
                      <div className="rounded-xl border border-sky-500/30 bg-sky-950/40 px-3 py-2 font-semibold text-sky-300">
                        Ancienne résistance ${resistanceValue.toFixed(2)} franchie — support potentiel.
                      </div>
                    )}
                    {!resistanceUnderSpot &&
    isValidLevel(resistanceValue) &&
                      Number.isFinite(priceValue) &&
                      resistanceDistancePct != null && (
                        <div className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2 font-semibold text-slate-200">
                          Résistance ${resistanceValue.toFixed(2)} — à {Math.abs(resistanceDistancePct).toFixed(1)} % du spot.
                        </div>
                      )}
                    {rsiHigh && (
                      <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 font-semibold text-amber-300">
                        RSI élevé : surachat court terme
                      </div>
                    )}
                    <SupportStatusLine item={item} />
                    <IbkrBatchCardDetails item={item} row={ibkrBatchRow} />
                  </div>
                </details>
              </div>
              <div className="rounded-[6px] border border-[#132536] bg-[#06111b]/70 px-3 py-2 text-xs text-slate-400">
                Note : les niveaux techniques proviennent des 60 derniers jours (daily). Les prix et options sont en temps réel via IBKR.
              </div>
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

async function callWheelJournalCapture({
  candidates,
  topN,
  scanTimestamp,
  scanSessionId,
  selectedExpiration,
  captureSource,
  dteAtScan,
}) {
  const response = await fetch(`${API_BASE}/journal/wheel-validation/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      candidates,
      topN,
      scanTimestamp,
      scanSessionId,
      selectedExpiration,
      captureSource,
      dteAtScan,
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

async function callIbkrDirectScan({
  tickers,
  expiration,
  clientIdStart,
  maxTickers,
  topN,
  auditDepth,
}) {
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
      auditDepth: Number(auditDepth ?? maxTickers ?? topN),
      ibkrValidationCount: Number(auditDepth ?? maxTickers ?? topN),
      sort: "elite",
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

function getSafeSpreadPct(item) {
  return normalizedIbkrSpreadPctPercent(
    item?.safeStrike?.liquidity?.spreadPct ??
      item?.safeStrike?.spreadPct ??
      item?.ibkrSpreadPct ??
      item?.spreadPct
  );
}

function getAggressiveSpreadPct(card) {
  return normalizedIbkrSpreadPctPercent(
    card?.aggressiveStrike?.liquidity?.spreadPct ??
    card?.aggressiveStrike?.spreadPct
  );
}

function isUnknownUnvalidatedTicker(card) {
  const meta = getTickerDisplayMeta(String(card?.ticker ?? "").toUpperCase());
  return meta.qualityTier === "Inconnu à valider";
}

function getCreamQualityScore(card) {
  const meta = getTickerDisplayMeta(String(card?.ticker ?? "").toUpperCase());
  let score = 0;
  const TIER_PTS = {
    "Core Quality": 30, "Cyclique": 22, "Spéculatif favori": 18,
    "Thématique risqué": 12, "Inconnu à valider": 5, "Crypto bloqué": 0,
  };
  score += TIER_PTS[meta.qualityTier] ?? 5;
  const safe = getSafeSpreadPct(card);
  const agg = getAggressiveSpreadPct(card);
  const spreadValues = [safe, agg].filter((v) => Number.isFinite(v));
  const sp = spreadValues.length ? Math.min(...spreadValues) : null;
  if (sp == null || sp > 80) score += 0;
  else if (sp > 50) score += 2;
  else if (sp > 35) score += 8;
  else if (sp > 25) score += 15;
  else if (sp > 15) score += 20;
  else score += 25;
  const dist = Number(card?.safeStrike?.distancePct ?? NaN);
  if (Number.isFinite(dist)) {
    if (dist <= -15) score += 20;
    else if (dist <= -10) score += 17;
    else if (dist <= -7) score += 13;
    else if (dist <= -5) score += 8;
    else score += 3;
  }
  const wr = Number(card?.weeklyReturn ?? 0);
  if (wr >= 1.0) score += 15;
  else if (wr >= 0.75) score += 12;
  else if (wr >= 0.50) score += 9;
  else score += 3;
  let tech = 5;
  const rsi = Number(card?.rsi);
  if (Number.isFinite(rsi) && rsi > 75) tech -= 4;
  if (card?.hasUpcomingEarningsBeforeExpiration === true || card?.hasEarningsBeforeExpiration === true) tech -= 5;
  if (
    card?.safeStrike?.strike != null &&
    card?.aggressiveStrike?.strike != null &&
    card.safeStrike.strike === card.aggressiveStrike.strike &&
    (sp == null || sp > 15)
  ) tech -= 2;
  score += Math.max(0, Math.min(10, tech));
  return Math.max(0, Math.min(100, Math.round(score)));
}

function getCreamQualityBucket(card) {
  const meta = getTickerDisplayMeta(String(card?.ticker ?? "").toUpperCase());
  const safe = getSafeSpreadPct(card);
  const agg = getAggressiveSpreadPct(card);
  const wr = Number(card?.weeklyReturn ?? 0);
  const dist = Number(card?.safeStrike?.distancePct ?? NaN);
  const hasEarnings =
    card?.hasUpcomingEarningsBeforeExpiration === true ||
    card?.hasEarningsBeforeExpiration === true;
  const rsi = Number(card?.rsi);
  if (isUnknownUnvalidatedTicker(card)) {
    return { bucket: "unknownReview", label: "Inconnus à valider", reasons: ["Ajouter à tickerMeta.js pour le classer"] };
  }

  if (meta.isCryptoBlocked && !meta.isCryptoAllowed) {
    return { bucket: "cryptoBlocked", label: "Crypto bloqués / exclus", reasons: ["crypto non autorisé stratégie Wheel"] };
  }
  if (meta.qualityTier === "Inconnu à valider") {
    return { bucket: "unknownReview", label: "Inconnus à valider", reasons: ["Ajouter à tickerMeta.js pour le classer"] };
  }
  if ((safe != null && safe > 80) || (agg != null && agg > 80)) {
    const worst = Math.max(safe ?? 0, agg ?? 0);
    return { bucket: "spreadRejected", label: "Rejetés pour spread", reasons: [`spread extrême ${worst.toFixed(0)}%`] };
  }
  const { finalDisplayMode: mode, finalDisplayGrade: recGrade } = getFinalDisplayRecommendation(card);
  const isTopGrade = (mode === "SAFE" || mode === "AGGRESSIVE") && (recGrade === "A" || recGrade === "B");
  const isWatchable = (mode === "SAFE" || mode === "AGGRESSIVE") && recGrade === "WATCH";

  if (isTopGrade) {
    const reasons = [];
    const activeSpread = mode === "AGGRESSIVE" ? agg : safe;
    if (activeSpread != null) {
      if (activeSpread <= 10) reasons.push("spread excellent");
      else if (activeSpread <= 20) reasons.push("spread acceptable");
      else reasons.push("spread limite");
    }
    reasons.push(`grade ${recGrade}`);
    if (mode === "AGGRESSIVE") reasons.push("mode agressif");
    return { bucket: "topExecutable", label: "Top exécutables", reasons };
  }
  if (meta.isFavorite) {
    const reasons = [];
    if (safe != null && safe > 20) reasons.push(`spread safe ${safe.toFixed(0)}%`);
    if (Number.isFinite(rsi) && rsi > 75) reasons.push(`RSI ${rsi.toFixed(0)}`);
    if (hasEarnings) reasons.push("earnings avant expiration");
    if (wr < 0.50) reasons.push("rendement insuffisant");
    if (Number.isFinite(dist) && dist > -5) reasons.push("distance trop proche");
    if (mode === "REJECT") reasons.push("rejeté spread/liquidité");
    else if (isWatchable) reasons.push("à surveiller");
    return { bucket: "favoriteWatch", label: "Favoris surveillés", reasons: reasons.length ? reasons : ["favori à surveiller"] };
  }
  if (isWatchable) {
    const reasons = [];
    const activeSpread = mode === "AGGRESSIVE" ? agg : safe;
    if (activeSpread != null && activeSpread > 20) reasons.push(`spread ${activeSpread.toFixed(0)}%`);
    if (Number.isFinite(dist) && dist > -5) reasons.push("distance trop proche");
    if (wr < 0.40) reasons.push("rendement insuffisant");
    if (hasEarnings) reasons.push("earnings");
    return { bucket: "watchOnly", label: "Autres à surveiller", reasons: reasons.length ? reasons : ["conditions à surveiller"] };
  }
  const reasons = [];
  if (safe != null && safe > 20) reasons.push(`spread safe ${safe.toFixed(0)}%`);
  if (agg != null && agg > 20) reasons.push(`spread agressif ${agg.toFixed(0)}%`);
  if (wr < 0.40) reasons.push("rendement insuffisant");
  if (hasEarnings) reasons.push("earnings");
  return { bucket: "watchOnly", label: "Autres à surveiller", reasons: reasons.length ? reasons : ["conditions non réunies"] };
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
      label: "spread acceptable",
      reason: "spread acceptable",
      badgeClass: "border-yellow-200 bg-yellow-50 text-yellow-800",
      textClass: "text-yellow-800",
      metricTone: "warn",
    };
  }
  if (pct <= 20) {
    return {
      label: "spread limite",
      reason: "spread limite",
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

function classifyEliteBadge(eliteBadge) {
  const badge = String(eliteBadge || "");
  if (badge === "Elite") return "border-emerald-300 bg-emerald-50 text-emerald-800";
  if (badge === "Strong") return "border-cyan-300 bg-cyan-50 text-cyan-800";
  if (badge === "Moderate") return "border-amber-300 bg-amber-50 text-amber-900";
  return "border-rose-300 bg-rose-50 text-rose-800";
}

function hasEarningsBeforeExpirationUi(item) {
  return (
    item?.hasUpcomingEarningsBeforeExpiration === true ||
    item?.hasEarningsBeforeExpiration === true ||
    item?.hasEarnings === true
  );
}

function premiumTargetMetUi(item) {
  const safe = item?.safeStrike;
  const premium = Number(safe?.premiumUsed ?? safe?.primeUsed ?? safe?.bid ?? safe?.mid);
  const target = Number(item?.minPremium);
  return Number.isFinite(premium) && Number.isFinite(target) && premium >= target;
}

function getIbkrActionabilityProfile(item) {
  const safe = item?.safeStrike;
  const spreadPct = getSafeSpreadPct(item);
  const noEarnings = !hasEarningsBeforeExpirationUi(item);
  const spreadExcellent = spreadPct != null && spreadPct <= 7;
  const spreadAcceptable = spreadPct != null && spreadPct > 7 && spreadPct <= 10;
  const spreadNetMalus = spreadPct != null && spreadPct > 10 && spreadPct <= 15;
  const spreadStrongMalus = spreadPct != null && spreadPct > 15 && spreadPct <= 20;
  const spreadOver20 = spreadPct != null && spreadPct > 20;
  const spreadOver10 = spreadPct != null && spreadPct > 10 && spreadPct <= 20;
  const spreadOk = spreadPct != null && spreadPct <= 10;
  const spreadBucket = spreadPct == null
    ? "unknown"
    : spreadExcellent
    ? "<=7"
    : spreadAcceptable
    ? ">7<=10"
    : spreadNetMalus
    ? ">10<=15"
    : spreadStrongMalus
    ? ">15<=20"
    : ">20";
  const spreadPenalty = spreadPct == null
    ? 120_000
    : spreadExcellent
    ? 0
    : spreadAcceptable
    ? 35_000
    : spreadNetMalus
    ? 360_000
    : spreadStrongMalus
    ? 1_250_000
    : 3_000_000;
  const primeOk = premiumTargetMetUi(item);
  const distance = Math.abs(Number(safe?.distancePct ?? item?.strikeDistance ?? 0));
  const pop = Number(safe?.popProfitEstimated ?? safe?.popEstimate ?? 0);
  const weekly = Number(safe?.weeklyYield ?? item?.weeklyReturn ?? 0);
  const eliteScore = Number(item?.eliteScore ?? 0);
  const finalTradeQualityScore = Number(item?.finalTradeQualityScore);
  const hasExceptionalFtqs = Number.isFinite(finalTradeQualityScore) && finalTradeQualityScore >= 90;
  const top10GuardrailPenalty =
    spreadPct == null
      ? 0
      : spreadPct > 20
      ? 6_000_000
      : spreadPct > 15
      ? hasExceptionalFtqs
        ? 900_000
        : 2_800_000
      : spreadPct > 10
      ? 950_000
      : 0;
  const safeEqualsAggressive =
    safe?.strike != null &&
    item?.aggressiveStrike?.strike != null &&
    Number(safe.strike) === Number(item.aggressiveStrike.strike);

  let bucket = 1;
  let label = "À surveiller";
  if (!noEarnings || spreadOver20) {
    bucket = 2;
    label = "Non actionnable";
  } else if (spreadStrongMalus || safeEqualsAggressive) {
    bucket = 1;
    label = "À surveiller";
  } else if (spreadNetMalus) {
    bucket = 1;
    label = "À surveiller";
  } else if (spreadOk && noEarnings) {
    bucket = 0;
    label = "Actionnable";
  }

  return {
    bucket,
    label,
    finalTradeQualityScore: Number.isFinite(finalTradeQualityScore)
      ? finalTradeQualityScore
      : null,
    weeklyYield: Number.isFinite(weekly) ? weekly : null,
    eliteScore: Number.isFinite(eliteScore) ? eliteScore : null,
    score:
      (2 - bucket) * 10_000_000 +
      (
    (noEarnings ? 1_000_000 : 0) +
    (spreadExcellent ? 180_000 : spreadAcceptable ? 60_000 : 0) -
    spreadPenalty -
    top10GuardrailPenalty +
    (primeOk ? 10_000 : 0) +
    Math.min(distance, 30) * 100 +
    (Number.isFinite(pop) ? pop * 100 : 0) +
    (Number.isFinite(weekly) ? weekly : 0) +
    (Number.isFinite(eliteScore) ? eliteScore * 1000 : 0)
      ),
    spreadPct,
    spreadBucket,
    spreadPenalty,
    top10GuardrailPenalty,
    noEarnings,
    spreadOver20,
    spreadOver10,
    spreadStrongMalus,
    spreadNetMalus,
    spreadAcceptable,
    spreadExcellent,
    safeEqualsAggressive,
  };
}

function liveActionabilityScore(item) {
  return getIbkrActionabilityProfile(item).score;
}

function sortByLiveActionability(a, b) {
  const pa = getIbkrActionabilityProfile(a || null);
  const pb = getIbkrActionabilityProfile(b || null);
  if (pa.bucket !== pb.bucket) return pa.bucket - pb.bucket;

  const aFtqs = Number(pa?.finalTradeQualityScore);
  const bFtqs = Number(pb?.finalTradeQualityScore);
  const aHasFtqs = Number.isFinite(aFtqs);
  const bHasFtqs = Number.isFinite(bFtqs);
  if (aHasFtqs && bHasFtqs && bFtqs !== aFtqs) return bFtqs - aFtqs;
  if (aHasFtqs && !bHasFtqs) return -1;
  if (!aHasFtqs && bHasFtqs) return 1;

  const aSpread = Number(pa?.spreadPct);
  const bSpread = Number(pb?.spreadPct);
  const aHasSpread = Number.isFinite(aSpread);
  const bHasSpread = Number.isFinite(bSpread);
  if (aHasSpread && bHasSpread && aSpread !== bSpread) return aSpread - bSpread;
  if (aHasSpread && !bHasSpread) return -1;
  if (!aHasSpread && bHasSpread) return 1;

  const aWeekly = Number(pa?.weeklyYield);
  const bWeekly = Number(pb?.weeklyYield);
  const aHasWeekly = Number.isFinite(aWeekly);
  const bHasWeekly = Number.isFinite(bWeekly);
  if (aHasWeekly && bHasWeekly && bWeekly !== aWeekly) return bWeekly - aWeekly;
  if (aHasWeekly && !bHasWeekly) return -1;
  if (!aHasWeekly && bHasWeekly) return 1;

  const aElite = Number(pa?.eliteScore);
  const bElite = Number(pb?.eliteScore);
  const aHasElite = Number.isFinite(aElite);
  const bHasElite = Number.isFinite(bElite);
  if (aHasElite && bHasElite && bElite !== aElite) return bElite - aElite;
  if (aHasElite && !bHasElite) return -1;
  if (!aHasElite && bHasElite) return 1;

  return pb.score - pa.score;
}

function getIbkrActionabilityStatus(item) {
  if (!item || typeof item !== "object") {
    return { label: "À surveiller", tone: "warn", className: "border-amber-200 bg-amber-50 text-amber-900" };
  }
  const { finalDisplayMode: mode, finalDisplayGrade: grade } = getFinalDisplayRecommendation(item);
  if (mode === "REJECT" || mode === "SAFE" || mode === "AGGRESSIVE") {
    if (mode === "REJECT") {
      return { label: "Non actionnable", tone: "bad", className: "border-rose-200 bg-rose-50 text-rose-700" };
    }
    if (grade === "A" || grade === "B") {
      return { label: "Actionnable", tone: "good", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
    }
    if (grade === "WATCH") {
      return { label: "À surveiller", tone: "warn", className: "border-amber-200 bg-amber-50 text-amber-900" };
    }
    return { label: "Non actionnable", tone: "bad", className: "border-rose-200 bg-rose-50 text-rose-700" };
  }
  const profile = getIbkrActionabilityProfile(item);
  if (!profile || typeof profile !== "object") {
    return { label: "À surveiller", tone: "warn", className: "border-amber-200 bg-amber-50 text-amber-900" };
  }
  if (profile.bucket === 2) return { label: "Non actionnable", tone: "bad", className: "border-rose-200 bg-rose-50 text-rose-700" };
  if (profile.bucket === 0) return { label: "Actionnable", tone: "good", className: "border-emerald-200 bg-emerald-50 text-emerald-700" };
  return { label: "À surveiller", tone: "warn", className: "border-amber-200 bg-amber-50 text-amber-900" };
}

function getRetainedNotDisplayedReason(item, displayedCutoffScore) {
  const profile = getIbkrActionabilityProfile(item || null);
  if (hasEarningsBeforeExpirationUi(item)) return "earnings avant expiration";
  if (profile?.spreadOver20) return "spread trop large";
  if (profile?.spreadOver10) return "spread limite";
  const score = liveActionabilityScore(item);
  if (Number.isFinite(displayedCutoffScore) && score < displayedCutoffScore) {
    return "moins bon que les 10 finaux";
  }
  return "moins prioritaire après tri live";
}

function inferInstrumentType({ quoteType, category, sector, symbol }) {
  const qt = String(quoteType || "").trim().toLowerCase();
  const cat = String(category || "").trim().toLowerCase();
  const sec = String(sector || "").trim();
  const sym = String(symbol || "").trim().toUpperCase();
  if (qt.includes("etf") || cat.includes("etf")) {
    if (/\b(2x|3x|ultra|bear|bull)\b/i.test(cat) || /(U|X)$/.test(sym)) return "Leveraged ETF";
    if (cat.includes("crypto") || /bitcoin|ethereum|crypto/i.test(cat)) return "Crypto ETF";
    return "ETF";
  }
  if (qt.includes("equity") || qt.includes("stock")) {
    if (/financial|bank|insurance|capital markets/i.test(sec)) return "Finance";
    if (/energy|oil|gas/i.test(sec)) return "Energy";
    if (/technology|software|semiconductor/i.test(sec)) return "Tech";
    return "Stock";
  }
  if (/financial|bank|insurance|capital markets/i.test(sec)) return "Finance";
  if (/energy|oil|gas/i.test(sec)) return "Energy";
  if (/technology|software|semiconductor/i.test(sec)) return "Tech";
  return "Stock";
}

function mergeIbkrProgressPayloads({
  baseExpiration,
  payloads,
  testedSymbols,
  finalDisplayedTarget,
  poolSize,
}) {
  const shortlist = [];
  const rejected = [];
  const errors = [];
  const shortlistDev = [];
  const warnings = [];
  const seenKept = new Set();

  // Timing accumulators across all sub-batch payloads
  let aggTotalMs = 0;
  let aggIbkrMs = 0;
  let aggIbkrCalls = 0;
  let aggOptionMd = 0;
  let aggQualify = 0;
  let aggTimeouts = 0;
  let aggTickerCount = 0;
  let aggIbkrMode = null;
  let hasTiming = false;

  for (const payload of payloads) {
    for (const item of Array.isArray(payload?.shortlist) ? payload.shortlist : []) {
      const symbol = String(item?.symbol || "").trim().toUpperCase();
      if (!symbol || seenKept.has(symbol)) continue;
      seenKept.add(symbol);
      shortlist.push(item);
    }
    rejected.push(...(Array.isArray(payload?.rejected) ? payload.rejected : []));
    errors.push(...(Array.isArray(payload?.errors) ? payload.errors : []));
    shortlistDev.push(...(Array.isArray(payload?.shortlistDev) ? payload.shortlistDev : []));
    warnings.push(...(Array.isArray(payload?.warnings) ? payload.warnings : []));

    const st = payload?.scanTiming;
    if (st && typeof st === "object") {
      hasTiming = true;
      aggTotalMs += (Number(st.totalSeconds) || 0) * 1000;
      aggIbkrMs += (Number(st.ibkrSeconds) || 0) * 1000;
      aggIbkrCalls += Number(st.ibkrTotalCalls) || 0;
      aggOptionMd += Number(st.ibkrOptionMarketDataRequests) || 0;
      aggQualify += Number(st.ibkrQualifyCalls) || 0;
      aggTimeouts += Number(st.timeoutCount) || 0;
      aggTickerCount += Number(st.tickerCount) || 0;
      if (!aggIbkrMode && st.ibkrMode) aggIbkrMode = st.ibkrMode;
    }
  }

  const mergedScanTiming = hasTiming
    ? {
        totalSeconds: +(aggTotalMs / 1000).toFixed(1),
        ibkrSeconds: +(aggIbkrMs / 1000).toFixed(1),
        avgIbkrPerTicker:
          aggTickerCount > 0 ? +(aggIbkrMs / aggTickerCount / 1000).toFixed(1) : null,
        ibkrMode: aggIbkrMode,
        tickerCount: aggTickerCount,
        keptCount: shortlist.length,
        rejectedCount: rejected.length,
        timeoutCount: aggTimeouts,
        ibkrTotalCalls: aggIbkrCalls || null,
        ibkrOptionMarketDataRequests: aggOptionMd || null,
        ibkrQualifyCalls: aggQualify || null,
      }
    : null;

  return {
    ok: true,
    expiration: payloads.find((p) => p?.expiration)?.expiration ?? ymdToIbkr(baseExpiration),
    scanned: testedSymbols.length,
    kept: shortlist.length,
    returned: shortlist.length,
    shortlist,
    rejected,
    errors,
    shortlistDev,
    warnings: [...new Set(warnings.filter(Boolean))],
    progressiveAutoIbkr: true,
    finalDisplayedTarget,
    totalKeptCollected: shortlist.length,
    retainedNotDisplayed: Math.max(0, shortlist.length - finalDisplayedTarget),
    testedSymbols,
    rejectedReplaced: Math.max(0, testedSymbols.length - shortlist.length),
    nonTestedCandidates: Math.max(0, poolSize - testedSymbols.length),
    scanTiming: mergedScanTiming,
    durationMs: hasTiming ? Math.round(aggTotalMs) : null,
    ibkrDurationMs: hasTiming ? Math.round(aggIbkrMs) : null,
  };
}

/** Diagnostic spread sur les retenus (safe strike). */
function countIbkrRetainedSafeSpreadBuckets(shortlist) {
  let gt10 = 0;
  let gt20 = 0;
  for (const row of shortlist || []) {
    const pct = getSafeSpreadPct(row);
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

function ScanDiagBlock({ ibkrResult, yahooScanTiming }) {
  const st = ibkrResult?.scanTiming;
  const ibkrMode = st?.ibkrMode ?? null;
  // Goal metrics — canonical names used in display labels
  const totalScanDurationSeconds = st?.totalSeconds ?? null;
  const ibkrPhaseDurationSeconds = st?.ibkrSeconds ?? null;
  const avgIbkrDurationPerTicker = st?.avgIbkrPerTicker ?? null;
  const ibkrApproxCalls = st?.ibkrTotalCalls ?? null;
  const ibkrOptionMarketDataCalls = st?.ibkrOptionMarketDataRequests ?? null;
  const ibkrQualifyCalls = st?.ibkrQualifyCalls ?? null;
  const ibkrTimeoutCount = st?.timeoutCount ?? null;
  const yahooSec = yahooScanTiming?.yahooSeconds ?? null;
  const keptCount = st?.keptCount ?? ibkrResult?.kept ?? null;
  const rejectedCount = st?.rejectedCount ?? (Array.isArray(ibkrResult?.rejected) ? ibkrResult.rejected.length : null);

  const hasAny = ibkrResult?.ok === true || yahooSec != null;
  if (!hasAny) return null;

  const row = (label, value, color = "text-slate-200") => (
    <div className="flex items-baseline justify-between gap-2 border-b border-slate-700/40 py-[3px] last:border-0">
      <span className="text-slate-400">{label}</span>
      <span className={`font-mono font-semibold ${color}`}>{value ?? "—"}</span>
    </div>
  );

  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-xs leading-5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          Diagnostic Scan
        </span>
        {ibkrMode && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
            ibkrMode === "TWO_PHASE"
              ? "bg-indigo-900 text-indigo-300"
              : "bg-emerald-900 text-emerald-300"
          }`}>
            {ibkrMode}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 gap-x-6">
        <div>
          {row("YAHOO PHASE", yahooSec != null ? `${yahooSec}s` : "—", "text-sky-300")}
          {row("IBKR PHASE", ibkrPhaseDurationSeconds != null ? `${ibkrPhaseDurationSeconds}s` : "—", "text-sky-300")}
          {row("SCAN TOTAL", totalScanDurationSeconds != null ? `${totalScanDurationSeconds}s` : "—", "text-emerald-300")}
          {row("AVG / TICKER", avgIbkrDurationPerTicker != null ? `${avgIbkrDurationPerTicker}s` : "—")}
          {row("RETENUS / REJETÉS", keptCount != null && rejectedCount != null ? `${keptCount} / ${rejectedCount}` : "—")}
        </div>
        <div>
          {row("APPROX CALLS", ibkrApproxCalls != null ? String(ibkrApproxCalls) : "—")}
          {row("MKT DATA OPTS", ibkrOptionMarketDataCalls != null ? String(ibkrOptionMarketDataCalls) : "—")}
          {row("QUALIFY CALLS", ibkrQualifyCalls != null ? String(ibkrQualifyCalls) : "—")}
          {row(
            "TIMEOUTS",
            ibkrTimeoutCount != null ? String(ibkrTimeoutCount) : "—",
            ibkrTimeoutCount > 0 ? "text-rose-400" : "text-slate-200"
          )}
        </div>
      </div>
    </div>
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
  yahooScanTiming,
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
  const perfSummary =
    result?.ibkrPerfSummary && typeof result.ibkrPerfSummary === "object"
      ? result.ibkrPerfSummary
      : null;
  const slowestTickers = Array.isArray(perfSummary?.slowestTickers)
    ? perfSummary.slowestTickers
    : [];
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

            <ScanDiagBlock ibkrResult={result} yahooScanTiming={yahooScanTiming} />

            {perfSummary && (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                <p className="font-semibold text-slate-900">Instrumentation performance IBKR</p>
                <div className="mt-3 grid gap-3 md:grid-cols-4">
                  <Metric label="Durée moyenne / ticker" value={perfSummary.avgDurationMs == null ? "—" : `${perfSummary.avgDurationMs} ms`} />
                  <Metric label="Médiane / ticker" value={perfSummary.medianDurationMs == null ? "—" : `${perfSummary.medianDurationMs} ms`} />
                  <Metric label="P95 / ticker" value={perfSummary.p95DurationMs == null ? "—" : `${perfSummary.p95DurationMs} ms`} />
                  <Metric label="Timeouts" value={String(perfSummary.timeoutCount ?? 0)} tone={Number(perfSummary.timeoutCount || 0) > 0 ? "warn" : "good"} />
                  <Metric label="Rows mesurées" value={`${perfSummary.rowsWithDuration ?? 0}/${perfSummary.scannedRows ?? 0}`} />
                  <Metric label="Kept / Rejected" value={`${perfSummary.keptCount ?? 0} / ${perfSummary.rejectedCount ?? 0}`} />
                  <Metric label="Durée batch IBKR" value={perfSummary.batchDurationMs == null ? "—" : `${perfSummary.batchDurationMs} ms`} />
                  <Metric label="Durée endpoint" value={perfSummary.serverDurationMs == null ? "—" : `${perfSummary.serverDurationMs} ms`} />
                </div>
                <div className="mt-3">
                  <p className="font-medium text-slate-900">Top 10 tickers les plus lents</p>
                  {slowestTickers.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">Aucune donnée de latence ticker.</p>
                  ) : (
                    <div className="mt-2 space-y-1 text-xs text-slate-700">
                      {slowestTickers.slice(0, 10).map((row, index) => (
                        <div key={`ibkr-slowest-${row.symbol || index}-${index}`}>
                          {index + 1}. {row.symbol || "—"} · {row.durationMs == null ? "durée ?" : `${row.durationMs} ms`} · {String(row.status || "unknown")} · {formatIbkrReason(row.reason)} · approx calls {row.approxCalls ?? 0} · timeouts {row.timeouts ?? 0}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="space-y-3">
              <p className="font-semibold text-slate-900">Retenus IBKR total — bassin testé</p>
              {shortlist.map((item) => {
                const viewModel = buildIbkrRetainedViewModel(item);
                const selectedSpreadDisplay =
                  viewModel.selectedSpreadPct == null
                    ? "—"
                    : `${Number(viewModel.selectedSpreadPct).toFixed(2)}%`;
                return (
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
                        Mode {viewModel.finalDisplayMode} {viewModel.finalDisplayGrade ? `[${viewModel.finalDisplayGrade}]` : ""} · Yield{" "}
                        {viewModel.selectedYieldPct == null ? "—" : `${Number(viewModel.selectedYieldPct).toFixed(2)}%`} · Spread{" "}
                        {selectedSpreadDisplay} · Prime {formatMoneyOrDash(viewModel.selectedPremium)}
                      </div>
                    </div>

                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                      <IbkrMiniStrikeDetailsSelected
                        title="Safe IBKR"
                        strike={item.safeStrike}
                        isSelected={viewModel.safeSelected}
                        selectedGrade={viewModel.safeSelected ? viewModel.finalDisplayGrade : null}
                        selectedMode={viewModel.finalDisplayMode}
                      />
                      <IbkrMiniStrikeDetailsSelected
                        title="Agressif IBKR"
                        strike={item.aggressiveStrike}
                        isSelected={viewModel.aggressiveSelected}
                        selectedGrade={viewModel.aggressiveSelected ? viewModel.finalDisplayGrade : null}
                        selectedMode={viewModel.finalDisplayMode}
                      />
                    </div>

                    {Array.isArray(item.qualityReasons) && item.qualityReasons.length > 0 && (
                      <p className="mt-3 text-xs leading-5 text-slate-600">
                        {item.qualityReasons.filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                );
              })}
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

// Buckets affichés dans le panneau principal — cryptoBlocked exclu intentionnellement.
const CREAM_BUCKET_ORDER = [
  "topExecutable", "favoriteWatch", "watchOnly",
  "unknownReview", "spreadRejected",
];

const CREAM_BUCKET_CONFIG = {
  topExecutable:  { label: "Top exécutables",     border: "border-emerald-700", bg: "bg-emerald-950/20", text: "text-emerald-300", countBadge: "bg-emerald-900/60 text-emerald-200", tag: "bg-emerald-900 text-emerald-200" },
  favoriteWatch:  { label: "Favoris surveillés",  border: "border-amber-600",   bg: "bg-amber-950/20",   text: "text-amber-300",   countBadge: "bg-amber-900/60 text-amber-200",   tag: "bg-amber-900 text-amber-200" },
  watchOnly:      { label: "Autres à surveiller", border: "border-slate-500",   bg: "bg-slate-900/20",   text: "text-slate-400",   countBadge: "bg-slate-800/60 text-slate-300",   tag: "bg-slate-800 text-slate-300" },
  unknownReview:  { label: "Inconnus à valider",  border: "border-slate-600",   bg: "bg-slate-800/20",   text: "text-slate-300",   countBadge: "bg-slate-700/60 text-slate-200",   tag: "bg-slate-700 text-slate-300" },
  spreadRejected: { label: "Rejetés pour spread", border: "border-orange-700",  bg: "bg-orange-950/20",  text: "text-orange-300",  countBadge: "bg-orange-900/60 text-orange-200", tag: "bg-orange-900 text-orange-200" },
};

const CREAM_BUCKET_ICON = {
  topExecutable: "🏆", favoriteWatch: "⭐", watchOnly: "👁",
  unknownReview: "❓", spreadRejected: "⚠",
};

// Sections sans carte complète — affichage compact uniquement.
const CREAM_COMPACT_BUCKETS = new Set(["unknownReview", "spreadRejected"]);

function CremeDeLaCremePanel({ items, ibkrBatchByTicker, yahooRankForIbkrBySymbol, seasonalityMap, onOpenDetail, highlightedTicker = null }) {
  const [openBuckets, setOpenBuckets] = useState(() => new Set(["topExecutable", "favoriteWatch", "watchOnly"]));

  const classified = useMemo(() => {
    // cryptoBlocked initialisé mais non rendu — évite un crash sur .push()
    const groups = Object.fromEntries([...CREAM_BUCKET_ORDER, "cryptoBlocked"].map(b => [b, []]));
    items.forEach((item) => {
      const info = getCreamQualityBucket(item);
      const score = getCreamQualityScore(item);
      groups[info.bucket].push({ item, info, score });
    });
    CREAM_BUCKET_ORDER.forEach(b => groups[b].sort((a, z) => z.score - a.score));
    return groups;
  }, [items]);

  if (!items.length) return null;

  const visibleCount = items.length - (classified.cryptoBlocked?.length ?? 0);

  const toggle = (b) => setOpenBuckets(prev => {
    const next = new Set(prev);
    next.has(b) ? next.delete(b) : next.add(b);
    return next;
  });

  return (
    <div className="rounded-[12px] border border-[#1e3a52] bg-[#020811] overflow-hidden shadow-[0_0_0_1px_rgba(80,140,180,0.08)]">
      <div className="flex items-center gap-2 border-b border-[#172637] px-4 py-3">
        <Layers3 className="h-4 w-4 text-amber-400 shrink-0" />
        <span className="text-sm font-bold text-slate-100">Classement Crème de la crème</span>
        <span className="ml-1 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-400">
          {visibleCount} admissibles
        </span>
      </div>

      <div className="divide-y divide-[#172637]">
        {CREAM_BUCKET_ORDER.map((bucket) => {
          const group = classified[bucket];
          if (!group.length) return null;
          const cfg = CREAM_BUCKET_CONFIG[bucket];
          const isOpen = openBuckets.has(bucket);
          const isCompact = CREAM_COMPACT_BUCKETS.has(bucket);
          return (
            <div key={bucket}>
              <button
                onClick={() => toggle(bucket)}
                className="flex w-full items-center justify-between px-4 py-2.5 text-left transition-colors hover:bg-white/5"
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm">{CREAM_BUCKET_ICON[bucket]}</span>
                  <span className={`text-sm font-semibold ${cfg.text}`}>{cfg.label}</span>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${cfg.countBadge}`}>
                    {group.length}
                  </span>
                </div>
                <span className="text-xs text-slate-500">{isOpen ? "▲" : "▼"}</span>
              </button>

              {isOpen && isCompact && (
                <div className={`divide-y divide-[#172637] ${cfg.bg}`}>
                  {bucket === "unknownReview" && (
                    <p className="px-4 py-2 text-xs italic text-slate-500">
                      Ajouter ces tickers à tickerMeta.js pour les classer, ou les exclure.
                    </p>
                  )}
                  {group.map(({ item }) => {
                    const sym = String(item?.ticker ?? "").toUpperCase();
                    const safeSpread = getSafeSpreadPct(item);
                    const aggSpread = getAggressiveSpreadPct(item);
                    return (
                      <div key={sym} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 text-xs">
                        <span className="shrink-0 font-mono font-bold text-slate-200">{sym}</span>
                        {bucket === "unknownReview" && (
                          <>
                            <span className="italic text-slate-500">Nom indisponible</span>
                            <span className="text-slate-600">·</span>
                            <span className="italic text-slate-600">secteur non renseigné</span>
                            <span className="ml-auto rounded bg-slate-800 px-1.5 py-0.5 text-slate-500">
                              à ajouter dans tickerMeta.js
                            </span>
                          </>
                        )}
                        {bucket === "spreadRejected" && (
                          <>
                            {safeSpread != null && (
                              <span className="text-orange-400">safe {safeSpread.toFixed(0)}%</span>
                            )}
                            {aggSpread != null && (
                              <span className="text-orange-400">agg {aggSpread.toFixed(0)}%</span>
                            )}
                            <span className="italic text-slate-500">spread trop large</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              {isOpen && !isCompact && (
                <div className={`space-y-3 px-3 pb-3 pt-1 ${cfg.bg}`}>
                  {group.map(({ item, info, score }, idx) => {
                    const sym = String(item?.ticker ?? "").toUpperCase();
                    return (
                      <div key={sym} className="rounded-[8px] overflow-hidden">
                        <div
                          className={`flex flex-wrap items-center gap-1.5 border ${cfg.border} border-b-0 rounded-t-[8px] bg-[#020811] px-3 py-1.5`}
                        >
                          <span className="shrink-0 text-xs text-slate-400">Score crème</span>
                          <span className={`rounded px-1.5 py-0.5 text-xs font-bold ${cfg.tag}`}>
                            {score}/100
                          </span>
                          <span className={`rounded px-1.5 py-0.5 text-xs ${cfg.tag}`}>
                            {cfg.label.split(" ")[0]}
                          </span>
                          {info.reasons.slice(0, 3).map((r, i) => (
                            <span key={i} className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-slate-400">
                              {r}
                            </span>
                          ))}
                        </div>
                        <CandidateCard
                          item={item}
                          displayRank={idx + 1}
                          yahooRankForIbkr={yahooRankForIbkrBySymbol.get(sym)}
                          onOpenDetail={onOpenDetail}
                          ibkrBatchRow={ibkrBatchByTicker.get(sym) ?? null}
                          seasonality={seasonalityMap[sym] ?? null}
                          highlightedTicker={highlightedTicker}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DetailModal({ item, onClose }) {
  const { finalDisplayMode, finalDisplayGrade } = getFinalDisplayRecommendation(item);
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

  const relevantEarningsDate = pickRelevantEarningsDate({
    earningsDate: item.earningsDate ?? item.raw?.earningsDate ?? null,
    nextEarningsDate: item.nextEarningsDate ?? item.raw?.nextEarningsDate ?? null,
    earningsMoment: item.earningsMoment ?? item.raw?.earningsMoment ?? null,
    expiration: item.targetExpiration ?? item.expiration ?? item.raw?.expiration ?? null,
  });

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

  const supportWide =
    liveData?.supportResistance?.supportWide ??
    liveData?.supportResistance?.support ??
    item.supportWide ??
    item.support ??
    null;
  const supportNear =
    liveData?.supportResistance?.supportNear ??
    item.supportNear ??
    null;
  const resistanceCurrent =
    liveData?.supportResistance?.resistanceCurrent ??
    liveData?.supportResistance?.resistance ??
    item.resistanceCurrent ??
    item.resistance ??
    null;
  const resistanceAboveSpot =
    liveData?.supportResistance?.resistanceAboveSpot ??
    item.resistanceAboveSpot ??
    null;
  const resistanceStatus =
    liveData?.supportResistance?.resistanceStatus ??
    item.resistanceStatus ??
    "unavailable";
  const potentialSupportFromBrokenResistance =
    liveData?.supportResistance?.potentialSupportFromBrokenResistance ??
    item.potentialSupportFromBrokenResistance ??
    null;
  const support = supportWide;
  const resistance = resistanceCurrent;
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
  const quote = liveData?.quote ?? {};
  const detailMeta = getTickerDisplayMeta(item?.ticker);
  const companyName =
    item?.companyName ??
    item?.longName ??
    item?.shortName ??
    quote?.longName ??
    quote?.shortName ??
    detailMeta.name ??
    item?.name ??
    item?.ticker;
  const sector =
    item?.sector ??
    item?.profile?.sector ??
    quote?.sector ??
    detailMeta.sector ??
    "non disponible";
  const industry =
    item?.industry ??
    item?.profile?.industry ??
    quote?.industry ??
    (detailMeta.type ?? "non disponible");
  const businessSummary =
    item?.businessSummary ??
    item?.longBusinessSummary ??
    item?.profile?.longBusinessSummary ??
    quote?.longBusinessSummary ??
    quote?.businessSummary ??
    "Description non disponible.";
  const instrumentType = inferInstrumentType({
    quoteType: item?.quoteType ?? quote?.quoteType,
    category: item?.category ?? quote?.category,
    sector,
    symbol: item?.ticker,
  });

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
            <Metric
              label="DTE"
              value={Number.isFinite(Number(item?.dteDays)) ? `${Number(item.dteDays)} jours` : "—"}
            />
            <Metric label="Prime cible safe" value={`$${Number(item.minPremium || 0).toFixed(2)}`} />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <p className="text-sm font-semibold text-slate-900">Fiche entreprise</p>
            <div className="mt-2 grid grid-cols-1 gap-2 text-sm text-slate-700 md:grid-cols-2">
              <p><span className="font-semibold">Nom complet :</span> {companyName}</p>
              <p><span className="font-semibold">Type :</span> {instrumentType}</p>
              <p><span className="font-semibold">Secteur :</span> {sector}</p>
              <p><span className="font-semibold">Industrie :</span> {industry}</p>
            </div>
            <p className="mt-2 text-sm leading-6 text-slate-600">{businessSummary}</p>
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Metric
              label="Support large"
              value={isValidLevel(supportWide) ? `$${Number(supportWide).toFixed(2)}` : "non disponible"}
            />
            <Metric
              label="Support proche"
              value={isValidLevel(supportNear) ? `$${Number(supportNear).toFixed(2)}` : "non disponible"}
            />
            <Metric
              label="Support potentiel"
              value={
                isValidLevel(potentialSupportFromBrokenResistance) && resistanceStatus === "broken"
                  ? `$${Number(potentialSupportFromBrokenResistance).toFixed(2)}`
                  : resistanceStatus === "broken" && isValidLevel(resistanceCurrent)
                  ? `$${Number(resistanceCurrent).toFixed(2)}`
                  : "non disponible"
              }
              tone={resistanceStatus === "broken" ? "good" : "default"}
            />
            <Metric
              label="Résistance supérieure"
              value={
                isValidLevel(resistanceAboveSpot)
                  ? `$${Number(resistanceAboveSpot).toFixed(2)}`
                  : "non disponible"
              }
            />
            <Metric
              label="Résistance actuelle"
              value={isValidLevel(resistance) ? `$${Number(resistance).toFixed(2)}` : "non disponible"}
            />
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
                  : strikeVsSupportPct < 0
                  ? "good"
                  : strikeVsSupportPct <= 2
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
              dteDays={item.safeStrike.dteDays ?? item.dteDays}
              distancePct={item.safeStrike.distancePct}
                label="safe strike"
                meetsTarget={
                Number.isFinite(Number(item.safeStrike.mid)) &&
                Number(item.safeStrike.mid) >= Number(item.minPremium || 0)
              }
                liquidity={item.safeStrike.liquidity}
                isSelected={finalDisplayMode === "SAFE"}
                selectedGrade={finalDisplayMode === "SAFE" ? finalDisplayGrade : null}
                recommendedMode={finalDisplayMode}
                recommendedGrade={finalDisplayGrade}
                recommendationDiagnostics={item.recommendationDiagnostics}
                legKey="safe"
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
              dteDays={item.aggressiveStrike.dteDays ?? item.dteDays}
              distancePct={item.aggressiveStrike.distancePct}
                label="aggressive strike"
                meetsTarget={
                Number.isFinite(Number(item.aggressiveStrike.mid)) &&
                Number(item.aggressiveStrike.mid) >= Number(item.minPremium || 0)
              }
                liquidity={item.aggressiveStrike.liquidity}
                isSelected={finalDisplayMode === "AGGRESSIVE"}
                selectedGrade={finalDisplayMode === "AGGRESSIVE" ? finalDisplayGrade : null}
                recommendedMode={finalDisplayMode}
                recommendedGrade={finalDisplayGrade}
                recommendationDiagnostics={item.recommendationDiagnostics}
                legKey="aggressive"
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

function formatCapitalShortfallReason(reason) {
  const map = {
    caps_too_strict: "Caps de risque trop stricts pour ajouter un contrat sans dépasser la limite.",
    contract_size_too_large: "Capital restant insuffisant pour le prochain contrat admissible.",
    max_positions_limit: "Limite maximale de positions atteinte.",
    not_enough_candidates: "Pas assez de candidats admissibles pour remplir davantage le capital.",
    min_yield_or_execution_filter: "Filtres de rendement ou d'exécution trop stricts pour les candidats restants.",
  };
  return map[reason] ?? "Raison non déterminée.";
}

function formatCapitalShortfallReasonLegacy(reason) {
  const map = {
    caps_too_strict: "Caps de risque trop stricts pour ajouter un contrat sans dépasser la limite.",
    contract_size_too_large: "Capital restant insuffisant pour le prochain contrat admissible.",
    high_beta_cap_reached: "Cap high beta atteint pour les candidats restants.",
    max_positions_limit: "Limite maximale de positions atteinte.",
    no_clean_incremental_candidate: "Les candidats restants dégradent trop la diversification ou le profil de risque.",
    not_enough_candidates: "Pas assez de candidats admissibles pour remplir davantage le capital.",
    min_yield_or_execution_filter: "Filtres de rendement ou d'exécution trop stricts pour les candidats restants.",
    sector_cap_reached: "Cap secteur atteint pour les candidats restants.",
    theme_cap_reached: "Cap thème atteint pour les candidats restants.",
    ticker_cap_reached: "Cap ticker atteint pour les candidats restants.",
  };
  return map[reason] ?? "Raison non déterminée.";
}

const LABEL_TO_MODE_ID = {
  AGGRESSIVE: "aggressive",
  BALANCED: "balanced",
  SAFE: "conservative",
  "Agressif": "aggressive",
  "Équilibré": "balanced",
  "Conservateur": "conservative",
};

function PortfolioCombos({ combos, capital, onTickerClick = null }) {
  const [snapshotStatus, setSnapshotStatus] = useState(null);
  const [snapshotMsg, setSnapshotMsg] = useState("");
  const hasAnyPicks = combos.some((combo) => (combo?.picks?.length ?? 0) > 0);
  const comboDefinitions = [
    { key: "SAFE", aliases: ["SAFE", "Conservateur"], emptyMessage: "Aucune combinaison SAFE propre selon les critères actuels." },
    { key: "BALANCED", aliases: ["BALANCED", "Équilibré", "Équilibré"], emptyMessage: "Aucune combinaison BALANCED propre selon les critères actuels." },
    { key: "AGGRESSIVE", aliases: ["AGGRESSIVE", "Agressif"], emptyMessage: "Aucune combinaison AGGRESSIVE propre selon les critères actuels." },
  ];
  const visibleCombos = comboDefinitions.map((definition) => {
    const found = combos.find((combo) => definition.aliases.includes(combo?.label));
    return (
      found ?? {
        label: definition.key,
        positions: 0,
        totalCapital: 0,
        capitalPct: 0,
        avgWeeklyReturn: 0,
        freeCapital: capital,
        picks: [],
        capitalTargetReached: false,
        capitalShortfallReason: "not_enough_candidates",
        emptyMessage: definition.emptyMessage,
      }
    );
  });

  async function handleSaveSnapshot() {
    if (!hasAnyPicks) return;
    setSnapshotStatus("loading");
    setSnapshotMsg("");
    try {
      const payload = { accountCapital: capital, source: "manual_button" };
      for (const combo of visibleCombos) {
        if ((combo?.picks?.length ?? 0) === 0) continue;
        const modeKey = LABEL_TO_MODE_ID[combo.label];
        if (!modeKey) continue;
        payload[modeKey] = {
          picks: combo.picks,
          totalCapital: combo.totalCapital,
          freeCapital: combo.freeCapital,
          totalPremium: combo.picks.reduce((s, p) => s + p.premiumCollected, 0),
        };
      }
      const res = await fetch(`${API_BASE}/capital-combinations/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.ok) {
        setSnapshotStatus("ok");
        setSnapshotMsg(`ID : ${data.snapshotId?.slice(0, 8) ?? "?"}`);
      } else {
        setSnapshotStatus("error");
        setSnapshotMsg(data.error ?? "Erreur inconnue");
      }
    } catch (err) {
      setSnapshotStatus("error");
      setSnapshotMsg(err?.message ?? "Erreur réseau");
    }
  }

  const snapshotHeader = (
    <div className="flex items-center justify-between">
      <CardTitle className="text-xl text-slate-900">Combinaisons capital</CardTitle>
      <button
        onClick={handleSaveSnapshot}
        disabled={snapshotStatus === "loading" || !hasAnyPicks}
        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Database className="h-3.5 w-3.5" />
        {snapshotStatus === "loading" ? "Sauvegarde…" : "Sauvegarder snapshot"}
      </button>
    </div>
  );

  return (
    <Card className="rounded-[28px] border-slate-200 shadow-sm">
      <CardHeader>
        {snapshotHeader}
        {snapshotStatus === "ok" && (
          <p className="mt-1.5 text-xs text-green-600">Snapshot sauvegardé dans SQLite. {snapshotMsg}</p>
        )}
        {snapshotStatus === "error" && (
          <p className="mt-1.5 text-xs text-rose-600">Erreur : {snapshotMsg}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-2xl border border-sky-100 bg-sky-50/80 px-4 py-3 text-sm text-slate-700">
          <p className="font-medium text-slate-900">
            Chaque bloc représente une simulation indépendante utilisant le capital complet. Les montants ne s&apos;additionnent pas.
          </p>
          <p className="mt-1 text-xs text-slate-500">
            SAFE, BALANCED et AGGRESSIVE comparent trois politiques de sélection sur le même capital simulé.
          </p>
        </div>
        {visibleCombos.map((combo) => (
          <div key={combo.label} className="rounded-2xl border border-slate-200 p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-base font-semibold text-slate-900">{combo.label}</p>
                <p className="text-sm font-medium text-slate-700">
                  Simulation {combo.label} — capital simulé : {capital.toFixed(0)}$
                </p>
                <p className="text-sm text-slate-500">
                  {combo.positions} positions · Capital {combo.totalCapital.toFixed(0)}$ ({combo.capitalPct.toFixed(0)}%) · Rend. moy ~{combo.avgWeeklyReturn.toFixed(2)}%
                </p>
                {(combo.avgQualityScore != null || combo.qualitySpeculativeCount > 0 || combo.qualityCryptoMinerCount > 0 || combo.qualityPremiumTrapCount > 0) && (
                  <p className="mt-0.5 text-xs text-slate-400">
                    {combo.avgQualityScore != null && (
                      <span>Qualité moy. {Math.round(combo.avgQualityScore * 100)}/100</span>
                    )}
                    {combo.qualitySpeculativeCount > 0 && (
                      <span className="ml-2 text-amber-500">{combo.qualitySpeculativeCount} spéculatif{combo.qualitySpeculativeCount > 1 ? "s" : ""}</span>
                    )}
                    {combo.qualityCryptoMinerCount > 0 && (
                      <span className="ml-2 text-rose-500">{combo.qualityCryptoMinerCount} crypto/miner</span>
                    )}
                    {combo.qualityPremiumTrapCount > 0 && (
                      <span className="ml-2 text-rose-400">{combo.qualityPremiumTrapCount} premium trap</span>
                    )}
                  </p>
                )}
                {combo.concentrationRiskScore != null && (
                  <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-slate-500">
                    <span>Concentration : <span className={cn(
                      "font-medium",
                      combo.concentrationRiskScore > 0.65 ? "text-rose-600" :
                      combo.concentrationRiskScore > 0.45 ? "text-amber-500" : "text-green-600"
                    )}>{combo.concentrationRiskScore > 0.65 ? "élevée" : combo.concentrationRiskScore > 0.45 ? "moyenne" : "faible"}</span></span>
                    {combo.cryptoMinerCapitalPct > 0 && (
                      <span className={combo.cryptoMinerCapitalPct > 35 ? "text-rose-500" : ""}>Crypto/miner : {combo.cryptoMinerCapitalPct.toFixed(0)}%</span>
                    )}
                    {combo.highBetaCapitalPct > 0 && (
                      <span className={combo.highBetaCapitalPct > 40 ? "text-rose-500" : ""}>High beta : {combo.highBetaCapitalPct.toFixed(0)}%</span>
                    )}
                    <span>Diversif. : {Math.round(combo.diversificationHealthScore * 100)}/100</span>
                  </div>
                )}
                {combo.clusterWarnings?.length > 0 && (
                  <div className="mt-1 space-y-0.5">
                    {combo.clusterWarnings.map((w, i) => (
                      <p key={i} className="text-xs text-rose-600">Concentration élevée : {w}</p>
                    ))}
                  </div>
                )}
                {combo.crossModeOverlap?.crossModeWarnings?.length > 0 && (
                  <div className="mt-0.5">
                    {combo.crossModeOverlap.crossModeWarnings.map((w, i) => (
                      <p key={i} className="text-xs text-slate-400">{w}</p>
                    ))}
                  </div>
                )}
              </div>
              <Badge className="rounded-full border border-slate-300 bg-slate-50 text-slate-700">
                Libre {combo.freeCapital.toFixed(0)}$
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {combo.picks.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-3 text-sm text-slate-500">
                  {combo.emptyMessage ?? "Aucune combinaison propre selon les critères actuels."}
                </div>
              )}
              {combo.picks.map((pick) => (
                <div
                  key={`${combo.label}-${pick.ticker}`}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm"
                >
                  <div className="grid gap-2 md:grid-cols-10">
                    <div>
                      <button
                        type="button"
                        onClick={() => onTickerClick?.(pick.ticker)}
                        title={`Aller à la carte principale ${pick.ticker}`}
                        className="cursor-pointer font-semibold text-slate-900 transition hover:text-sky-700 hover:underline"
                      >
                        {pick.ticker}
                      </button>
                      {pick.qualityTier && pick.qualityTier !== "high" && (
                        <div className={cn(
                          "mt-0.5 text-xs font-medium",
                          pick.qualityTier === "medium" && "text-slate-400",
                          pick.qualityTier === "speculative" && "text-amber-500",
                          pick.qualityTier === "avoid" && "text-rose-600",
                        )}>
                          {pick.qualityTier}
                        </div>
                      )}
                    </div>
                    <div>{pick.mode ?? "—"} {pick.grade ? `[${pick.grade}]` : ""}</div>
                    <div>PUT {pick.strike}$</div>
                    <div>{pick.source || "Yahoo fallback"}</div>
                    <div>
                      {pick.premiumKind || "prime"} {pick.premiumUnit != null ? `${Number(pick.premiumUnit).toFixed(2)}$` : "—"}
                    </div>
                    <div>spread {pick.spreadPct != null ? `${Number(pick.spreadPct).toFixed(1)}%` : "—"}</div>
                    <div>yield {pick.weeklyReturn.toFixed(2)}%</div>
                    <div>dist. {pick.distancePct != null ? `${Number(pick.distancePct).toFixed(1)}%` : "—"}</div>
                    <div>×{pick.contracts}</div>
                    <div>{pick.capitalRequired.toFixed(0)}$</div>
                    <div>{pick.premiumCollected.toFixed(0)}$</div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span
                      className="rounded-full border border-slate-300 bg-white px-2 py-0.5 font-medium text-slate-700"
                      title={pick.selectionTooltip ?? undefined}
                    >
                      Score {pick.selectionScore}
                    </span>
                    {pick.selectionSummary && (
                      <span className="text-slate-500">{pick.selectionSummary}</span>
                    )}
                  </div>
                  {pick.selectionReason && (
                    <div className="mt-1 text-xs text-sky-700">
                      {pick.selectionReason}
                    </div>
                  )}
                  {(pick.concentrationTheme || (pick.qualityWarnings?.length > 0 && pick.qualityTier !== "high" && pick.qualityTier !== "medium")) && (
                    <div className="mt-1 text-xs text-amber-600">
                      {pick.concentrationTheme && <span className="mr-2">thème: {pick.concentrationTheme}</span>}
                      {pick.qualityWarnings
                        ?.filter((w) => w !== "Crypto miner" && w !== "High beta growth")
                        .slice(0, 2)
                        .join(" · ")}
                    </div>
                  )}
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

            {!combo.capitalTargetReached && combo.capitalShortfallReason && (
              <div className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Capital non utilisé — {formatCapitalShortfallReason(combo.capitalShortfallReason)}
              </div>
            )}
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
  const readStoredAutoJournalMode = () => {
    const raw = String(window.localStorage.getItem("wheel.autoJournalPop") || "off").trim().toLowerCase();
    return raw === "10" || raw === "30" || raw === "50" ? raw : "off";
  };
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("quality");
  const [sortOrder, setSortOrder] = useState("desc");
  const [selectedItem, setSelectedItem] = useState(null);
  const [highlightedTicker, setHighlightedTicker] = useState(null);
  const [activeView, setActiveView] = useState("dashboard");
  const tickerHighlightTimeoutRef = useRef(null);

  const [selectedExpiration, setSelectedExpiration] = useState(() =>
    pickDefaultExpiration(DEFAULT_EXPIRATIONS)
  );
  const selectedExpirationRef = useRef(selectedExpiration);

  useEffect(() => {
    selectedExpirationRef.current = selectedExpiration;
  }, [selectedExpiration]);

  useEffect(() => {
    return () => {
      if (tickerHighlightTimeoutRef.current != null) {
        window.clearTimeout(tickerHighlightTimeoutRef.current);
      }
    };
  }, []);

  const scrollToTickerCard = useCallback((symbol) => {
    const ticker = String(symbol || "").trim().toUpperCase();
    if (!ticker) return;
    const card = document.querySelector(`[data-ticker-card="${ticker}"]`);
    if (!card) {
      console.warn(`[capital-combos] ticker card not found for ${ticker}`);
      return;
    }
    card.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    setHighlightedTicker(ticker);
    if (tickerHighlightTimeoutRef.current != null) {
      window.clearTimeout(tickerHighlightTimeoutRef.current);
    }
    tickerHighlightTimeoutRef.current = window.setTimeout(() => {
      setHighlightedTicker((current) => (current === ticker ? null : current));
      tickerHighlightTimeoutRef.current = null;
    }, 2600);
  }, []);

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
  const [yahooDiagnostics, setYahooDiagnostics] = useState(() => createEmptyYahooDiagnostics());
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
  const [yahooScanTiming, setYahooScanTiming] = useState(null);
  const [autoIbkrDirectScan, setAutoIbkrDirectScan] = useState(true);
  const [ibkrAutoMaxTickers, setIbkrAutoMaxTickers] = useState(() =>
    readStoredNumber("wheel.ibkrAuditDepth", 20)
  );
  const [ibkrAutoClientIdStart] = useState("500");
  const [autoJournalPop, setAutoJournalPop] = useState(() => readStoredAutoJournalMode());
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

  // ── Seasonality V1 — optional enrichment, never blocks main scan ───────────
  const [seasonalityMap, setSeasonalityMap] = useState({});
  const fetchSeasonalityBatch = useCallback(async (symbols) => {
    if (!symbols?.length) return;
    try {
      const unique = [...new Set(
        symbols.map(s => String(s ?? "").trim().toUpperCase()).filter(Boolean),
      )].slice(0, 25);
      if (!unique.length) return;
      const resp = await fetch(
        `${API_BASE}/seasonality/scan-summary?tickers=${encodeURIComponent(unique.join(","))}`,
      );
      if (!resp.ok) return;
      const data = await resp.json();
      if (!data?.ok || !data?.results) return;
      setSeasonalityMap(prev => ({ ...prev, ...data.results }));
    } catch {
      // silently ignore — seasonality is optional enrichment
    }
  }, []);
  // ───────────────────────────────────────────────────────────────────────────

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
    setYahooDiagnostics(createEmptyYahooDiagnostics());
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

    const limitedSource =
      dataSource === "ibkr_direct"
        ? source
        : source.slice(0, topN);

    return limitedSource.map((item, index) => ({
      ...item,
      rank: index + 1,
    }));
  }, [backendCandidates, snapshotCandidates, dataSource, topN]);

  const enrichedCandidates = useMemo(() => {
    const enriched = activeCandidates.map((item, index) => {
      const symbol = String(item?.ticker || "").trim().toUpperCase();
      const ibkrCandidate = ibkrDirectByTicker.get(symbol);
      return ibkrCandidate
        ? mergeIbkrIntoDashboardCandidate(item, ibkrCandidate, index, selectedExpiration)
        : item;
    });

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
    // For ibkr_direct: establish ibkrRank base order (used as stable tie-breaker for equal sort values)
    let baseItems;
    if (dataSource === "ibkr_direct") {
      const hasBackendIbkrOrder = filteredItems.every((item) => Number.isFinite(Number(item?.ibkrRank)));
      const ibkrFallbackScore = (item) =>
        Number(item?.ibkrEliteScore ?? item?.eliteScore ?? item?.actionabilityScore ?? item?.score ?? Number.NEGATIVE_INFINITY);
      baseItems = hasBackendIbkrOrder
        ? filteredItems.slice()
        : filteredItems.slice().sort((a, b) => ibkrFallbackScore(b) - ibkrFallbackScore(a));
    } else {
      baseItems = filteredItems.slice();
    }

    const getSortValue = (item) => {
      if (sortBy === "quality")
        return Number(item.qualityScore ?? item.eliteScore ?? Number.NEGATIVE_INFINITY);
      if (sortBy === "weeklyReturn") return Number(item.weeklyReturn ?? 0);
      if (sortBy === "spread") {
        const spread = getSafeSpreadPct(item);
        return spread ?? Number.POSITIVE_INFINITY;
      }
      return Number(item.strikeDistance ?? 0);
    };

    const sorted = baseItems.sort((a, b) => {
      if (sortBy === "spread") {
        const aSpread = getSafeSpreadPct(a);
        const bSpread = getSafeSpreadPct(b);
        const aMissing = aSpread == null;
        const bMissing = bSpread == null;
        if (aMissing && bMissing) return Number(a.ibkrRank ?? a.rank ?? 0) - Number(b.ibkrRank ?? b.rank ?? 0);
        if (aMissing) return 1;
        if (bMissing) return -1;
      }
      const aValue = getSortValue(a);
      const bValue = getSortValue(b);
      if (aValue === bValue) return Number(a.ibkrRank ?? a.rank ?? 0) - Number(b.ibkrRank ?? b.rank ?? 0);
      return sortOrder === "asc" ? aValue - bValue : bValue - aValue;
    });

    if (import.meta.env.DEV) {
      console.debug("[SORT_UI]", { sortBy, sortOrder, dataSource, firstSymbols: sorted.slice(0, 5).map((i) => i.ticker) });
    }

    return sorted.filter((item) => candidateRowMatchesSelectedExpiration(item, selectedExpiration));
  }, [enrichedCandidates, query, filter, sortBy, sortOrder, selectedExpiration, dataSource]);

  // Seasonality V1: auto-fetch for all visible shortlist tickers (non-blocking)
  useEffect(() => {
    if (!filtered?.length) return;
    const symbols = filtered.map(item => String(item.ticker ?? item.symbol ?? "").toUpperCase()).filter(Boolean);
    fetchSeasonalityBatch(symbols);
  }, [filtered, fetchSeasonalityBatch]);

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
  const ibkrKeptSymbols = useMemo(() => {
    const rows = Array.isArray(ibkrDirectResult?.shortlist) ? ibkrDirectResult.shortlist : [];
    return new Set(
      rows
        .map((row) => String(row?.symbol || "").trim().toUpperCase())
        .filter(Boolean)
    );
  }, [ibkrDirectResult]);
  const ibkrRetainedBySymbol = useMemo(() => {
    const rows = Array.isArray(ibkrDirectResult?.shortlist) ? ibkrDirectResult.shortlist : [];
    return new Map(
      rows
        .map((row) => [String(row?.symbol || "").trim().toUpperCase(), row])
        .filter(([symbol]) => Boolean(symbol))
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

  const _rawWatchlist = watchlistTickers ?? FALLBACK_TICKERS;
  const tickersForScan = _rawWatchlist.filter(
    (t) => !USER_PREFS.cryptoBlocked.has(String(t || "").trim().toUpperCase())
  );
  const cryptoRemovedFromWatchlistCount = _rawWatchlist.length - tickersForScan.length;
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
  const yahooRejectedCount = Number(yahooDiagnostics?.rejectedTotal || 0);
  const yahooTopRejectionReasons = useMemo(
    () => topCountEntries(yahooDiagnostics?.rejectionReasonCounts, 10),
    [yahooDiagnostics]
  );
  const yahooTopStageRejectCounts = useMemo(
    () => topCountEntries(yahooDiagnostics?.stageRejectCounts, 10),
    [yahooDiagnostics]
  );
  const yahooRejectedSampleRows = useMemo(
    () =>
      Array.isArray(yahooDiagnostics?.rejectedSample)
        ? yahooDiagnostics.rejectedSample.slice(0, 20)
        : [],
    [yahooDiagnostics]
  );
  const ibkrRejectedCount = Array.isArray(ibkrDirectResult?.rejected) ? ibkrDirectResult.rejected.length : 0;
  const ibkrKeptCount = Number.isFinite(Number(ibkrDirectResult?.kept))
    ? Number(ibkrDirectResult.kept)
    : Array.isArray(ibkrDirectResult?.shortlist)
    ? ibkrDirectResult.shortlist.length
    : 0;
  const ibkrFinalTarget = Number.isFinite(Number(ibkrDirectResult?.finalDisplayedTarget))
    ? Number(ibkrDirectResult.finalDisplayedTarget)
    : Math.min(120, Math.max(10, Number(ibkrAutoMaxTickers) || 20));
  const ibkrTotalKeptCollected = Number.isFinite(Number(ibkrDirectResult?.totalKeptCollected))
    ? Number(ibkrDirectResult.totalKeptCollected)
    : ibkrKeptCount;
  const ibkrRetainedNotDisplayed = Number.isFinite(Number(ibkrDirectResult?.retainedNotDisplayed))
    ? Number(ibkrDirectResult.retainedNotDisplayed)
    : Math.max(0, ibkrTotalKeptCollected - ibkrFinalTarget);
  const ibkrTestedCount = Array.isArray(ibkrDirectResult?.testedSymbols)
    ? ibkrDirectResult.testedSymbols.length
    : ibkrSentCount;
  const ibkrRejectedReplaced = Number.isFinite(Number(ibkrDirectResult?.rejectedReplaced))
    ? Number(ibkrDirectResult.rejectedReplaced)
    : Math.max(0, ibkrTestedCount - ibkrKeptCount);
  const ibkrNonTestedCount = Number.isFinite(Number(ibkrDirectResult?.nonTestedCandidates))
    ? Number(ibkrDirectResult.nonTestedCandidates)
    : Math.max(0, yahooReturnedCount - ibkrTestedCount);
  const ibkrSentSet = useMemo(
    () => new Set((ibkrDirectSentTickers || []).map((t) => String(t || "").trim().toUpperCase()).filter(Boolean)),
    [ibkrDirectSentTickers]
  );
  const ibkrDisplayedSymbols = useMemo(
    () =>
      new Set(
        (backendCandidates || [])
          .map((row) => String(row?.ticker || row?.symbol || "").trim().toUpperCase())
          .filter(Boolean)
      ),
    [backendCandidates]
  );
  const ibkrDisplayedScoreFloor = useMemo(() => {
    const scores = (backendCandidates || [])
      .map((row) => liveActionabilityScore(row))
      .filter((s) => Number.isFinite(s));
    if (!scores.length) return null;
    return Math.min(...scores);
  }, [backendCandidates]);
  const ibkrAnyContactSymbols = useMemo(() => {
    const set = new Set();
    const add = (sym) => { const s = String(sym || "").trim().toUpperCase(); if (s) set.add(s); };
    for (const t of ibkrDirectSentTickers || []) add(t);
    for (const row of ibkrDirectResult?.shortlist || []) add(row?.symbol);
    for (const row of ibkrDirectResult?.rejected || []) add(row?.symbol);
    for (const row of backendCandidates || []) add(row?.ticker ?? row?.symbol);
    for (const row of ibkrAutoRankDiagnostics || []) add(row?.symbol);
    for (const item of filtered || []) add(item?.ticker);
    return set;
  }, [ibkrDirectSentTickers, ibkrDirectResult, backendCandidates, ibkrAutoRankDiagnostics, filtered]);

  const yahooNonSentCandidates = useMemo(() => {
    const offset = ibkrTestedCount > 0
      ? ibkrTestedCount
      : Math.min(Number(ibkrAutoMaxTickers) || 20, 120);
    return (yahooReturnedCandidates || [])
      .slice(offset, 30)
      .filter((item) => {
        const sym = String(item?.ticker || item?.symbol || "").trim().toUpperCase();
        return sym !== "" && !ibkrAnyContactSymbols.has(sym);
      });
  }, [yahooReturnedCandidates, ibkrAnyContactSymbols, ibkrTestedCount, ibkrAutoMaxTickers]);
  const sofiDiagnostic = useMemo(() => {
    const watchlist = Array.isArray(tickersForScan) ? tickersForScan : [];
    const watchlistIndex = watchlist.findIndex((t) => String(t || "").trim().toUpperCase() === "SOFI");
    const yahooIndex = (yahooReturnedCandidates || []).findIndex(
      (item) => String(item?.ticker || "").trim().toUpperCase() === "SOFI"
    );
    const sent = ibkrSentSet.has("SOFI");
    const rejected = ibkrRejectedSymbols.has("SOFI");
    const kept = ibkrKeptSymbols.has("SOFI");
    const displayed = ibkrDisplayedSymbols.has("SOFI");
    const objectiveFilled = ibkrDirectResult?.progressiveAutoIbkr === true && ibkrKeptCount >= ibkrFinalTarget;
    let statusText = "non testé";
    if (rejected) {
      statusText = "testé puis rejeté";
    } else if (kept && displayed) {
      statusText = "retenu affiché";
    } else if (kept && !displayed) {
      statusText = "testé mais non affiché après tri";
    } else if (!sent && yahooIndex >= 0 && ibkrNonTestedCount > 0) {
      statusText = "non testé car cap IBKR atteint";
    }
    return {
      inWatchlist: watchlistIndex >= 0,
      watchlistRank: watchlistIndex >= 0 ? watchlistIndex + 1 : null,
      inYahoo: yahooIndex >= 0,
      yahooRank: yahooIndex >= 0 ? yahooIndex + 1 : null,
      sent,
      rejected,
      kept,
      displayed,
      statusText,
      objectiveFilled,
    };
  }, [
    tickersForScan,
    yahooReturnedCandidates,
    ibkrSentSet,
    ibkrDirectResult,
    ibkrKeptCount,
    ibkrFinalTarget,
    ibkrRejectedSymbols,
    ibkrKeptSymbols,
    ibkrDisplayedSymbols,
    ibkrNonTestedCount,
  ]);
  const yahooActionabilityCounts = useMemo(() => {
    let actionable = 0;
    let watch = 0;
    let nonActionable = 0;
    for (const item of yahooReturnedCandidates || []) {
      const spreadPct = getSafeSpreadPct(item);
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
  const ibkrActionabilityCounts = useMemo(() => {
    const counts = { actionable: 0, watch: 0, nonActionable: 0 };
    for (const item of filtered || []) {
      if (item?.optionsSource !== "IBKR live") continue;
      const status = getIbkrActionabilityStatus(item);
      if (status.label === "Actionnable") counts.actionable += 1;
      else if (status.label === "Non actionnable") counts.nonActionable += 1;
      else counts.watch += 1;
    }
    return counts;
  }, [filtered]);
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

      const mappedAll = shortlistNorm.map((ibkrCandidate, index) => {
        const lookupKeys = buildCandidateLookupKeys(ibkrCandidate);
        const yahooCandidate =
          lookupKeys
            .map((key) => technicalCandidatesRef.current.get(key) ?? yahooCandidateByTicker.get(key))
            .find(Boolean) ?? null;
        return mergeIbkrIntoDashboardCandidate(yahooCandidate, ibkrCandidate, index, selectedExpiration);
      }).sort(sortByLiveActionability);
      const finalDisplayedTarget = Number.isFinite(Number(payload?.finalDisplayedTarget))
        ? Math.max(1, Number(payload.finalDisplayedTarget))
        : 10;
      const mapped = mappedAll.slice(0, finalDisplayedTarget);

      setBackendCandidates(mapped);
      setDataSource("ibkr_direct");
      setScanMeta({
        scanned: Number(payload?.scanned ?? mappedAll.length),
        kept: mapped.length,
        returned: mapped.length,
      });
      setPrimaryIbkrSourceInfo({
        twoPhaseEnabled: payload?.twoPhaseEnabled === true,
        devScanEnabled: payload?.devScanEnabled === true,
        devDisplayed: payload?.devDisplayedReturned ?? payload?.devDisplayed ?? shortlistDev.length,
        totalKeptCollected: Number(payload?.totalKeptCollected ?? mappedAll.length),
        finalDisplayedTarget,
        retainedNotDisplayed: Math.max(
          0,
          Number(payload?.retainedNotDisplayed ?? (mappedAll.length - mapped.length))
        ),
      });
      setScanError("");
      return mapped;
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

  const captureWheelJournalSnapshot = useCallback(
    async ({ candidates, scanSessionId, scanTimestamp, source }) => {
      const captureTopN = Number(autoJournalPop);
      const selectedExpiration = normalizeExpirationYmd(selectedExpirationRef.current);

      // Apply the same guards the dashboard uses:
      // 1. Exclude IBKR-rejected symbols (ibkrRejectedSymbols mirrors ibkrDirectResult.rejected)
      // 2. Exclude candidates whose embedded expiration fields don't match the active selection
      // Slice to captureTopN AFTER filtering so Top 50 means 50 *admissible* candidates.
      const rawCount = Array.isArray(candidates) ? candidates.length : 0;
      const finalCandidates = (Array.isArray(candidates) ? candidates : [])
        .filter((c) => {
          const sym = String(c?.ticker || "").trim().toUpperCase();
          if (sym && ibkrRejectedSymbols.has(sym)) return false;
          if (!candidateRowMatchesSelectedExpiration(c, selectedExpiration)) return false;
          return true;
        })
        .slice(0, captureTopN);

      console.log("[AUTO_JOURNAL_CAPTURE_ATTEMPT]", {
        scanSessionId,
        autoJournalPop,
        rawCandidatesLength: rawCount,
        finalCandidatesLength: finalCandidates.length,
        ibkrRejectedCount: ibkrRejectedSymbols.size,
        selectedExpiration,
        source,
        captureTopN,
      });

      if (autoJournalPop === "off") {
        console.log("[AUTO_JOURNAL_SKIP]", {
          reason: "off",
          scanSessionId,
          source,
        });
        return null;
      }

      if (finalCandidates.length === 0) {
        console.log("[AUTO_JOURNAL_SKIP]", {
          reason: "no_final_candidates",
          scanSessionId,
          source,
          rawCandidatesLength: rawCount,
          ibkrRejectedCount: ibkrRejectedSymbols.size,
        });
        return null;
      }

      const dteAtScan = computeDteAtScan(scanTimestamp ?? new Date().toISOString(), selectedExpiration);
      try {
        const payload = await callWheelJournalCapture({
          candidates: finalCandidates,
          topN: captureTopN,
          scanTimestamp: scanTimestamp ?? new Date().toISOString(),
          scanSessionId,
          selectedExpiration,
          captureSource: source,
          dteAtScan,
        });
        console.log("[AUTO_JOURNAL_RESULT]", {
          scanSessionId,
          captured: payload?.captured ?? null,
          duplicates: payload?.duplicates ?? null,
          candidatesSent: finalCandidates.length,
          totalReceived: Array.isArray(payload?.journal?.records) ? payload.journal.records.length : null,
          backendTotal: payload?.totalRecords ?? payload?.journal?.totalRecords ?? null,
        });
        return payload;
      } catch (error) {
        console.warn("[AUTO_JOURNAL_ERROR]", {
          scanSessionId,
          source,
          captureTopN,
          error: error?.message || String(error),
        });
        return null;
      }
    },
    [autoJournalPop, ibkrRejectedSymbols]
  );

  const runAutoIbkrDirectScan = useCallback(
    async (ibkrAutoInput) => {
      if (!autoIbkrDirectScan) return;
      if (!ibkrAutoInput || typeof ibkrAutoInput !== "object") return;

      const scanId = ibkrAutoInput.scanId != null ? String(ibkrAutoInput.scanId) : "no-scan-id";
      const { mode, orderedSymbols, expirationYmd, candidateBySymbol } = ibkrAutoInput;
      const scanTimestamp =
        ibkrAutoInput.scanTimestamp != null ? String(ibkrAutoInput.scanTimestamp) : new Date().toISOString();
      const expLocked = expirationYmd != null ? String(expirationYmd).trim() : "";
      if (!expLocked) return;
      if (normalizeExpirationYmd(selectedExpirationRef.current) !== normalizeExpirationYmd(expLocked)) {
        return;
      }

      const finalTargetRaw = Number(ibkrAutoMaxTickers) || 20;
      const finalTarget = Math.min(120, Math.max(10, finalTargetRaw));
      const hardEvaluationCap = finalTarget;
      const desiredFromInput = Number(ibkrAutoInput?.finalDisplayedTarget);
      const desiredFinalKept = Number.isFinite(desiredFromInput)
        ? Math.max(1, Math.min(hardEvaluationCap, Math.trunc(desiredFromInput)))
        : hardEvaluationCap;
      /** @type {{ symbol: string, score?: number, reasons: string[], tierBoost?: number, rank?: number, selectionMode: "yahoo_shortlist" | "watchlist_fallback" }[]} */
      let diagnostics = [];
      /** @type {string[]} */
      let candidatePool = [];
      /** @type {"yahoo_shortlist" | "watchlist_fallback"} */
      let sourceTag = "watchlist_fallback";

      if (mode === "yahoo_shortlist" && Array.isArray(orderedSymbols) && orderedSymbols.length > 0) {
        sourceTag = "yahoo_shortlist";
        const seen = new Set();
        const rankedYahooPool = [];
        for (const raw of orderedSymbols) {
          const symbol = String(raw || "").trim().toUpperCase();
          if (!symbol || seen.has(symbol)) continue;
          seen.add(symbol);
          const candidate = candidateByTickerForPreIbkr.get(symbol) ?? null;
          const { score, reasons } = computeIbkrPriorityScore(candidate);
          rankedYahooPool.push({
            symbol,
            yahooRank: rankedYahooPool.length + 1,
            score,
            reasons,
            selectionMode: "yahoo_shortlist",
          });
        }
        rankedYahooPool.sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score;
          return a.yahooRank - b.yahooRank;
        });
        candidatePool = rankedYahooPool.map((row) => row.symbol);
        diagnostics = rankedYahooPool.map((row, index) => ({
          symbol: row.symbol,
          rank: index + 1,
          score: row.score,
          reasons: row.reasons,
          selectionMode: "yahoo_shortlist",
          ibkrPriorityScore: row.score,
          ibkrPriorityReasons: row.reasons,
          yahooRank: row.yahooRank,
        }));
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
        candidatePool = ranked.map((row) => row.symbol);
        diagnostics = ranked.slice(0, finalTarget).map((row) => ({
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
        candidatePoolLength: candidatePool.length,
        maxTickers: finalTarget,
        desiredFinalKept,
        hardEvaluationCap,
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
      setIbkrAutoRankDiagnostics(diagnostics.slice(0, finalTarget));
      if (!candidatePool.length) {
        console.warn("[IBKR_AUTO_SKIPPED]", { scanId, reason: "tickersToSend vide après sélection" });
        setTimeout(() => {
          setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
        }, 0);
        return;
      }

      setRefreshStage("Étape 2/2 : IBKR Direct Scan — options live");
      setIbkrDirectLoading(true);
      setIbkrDirectError("");
      setIbkrDirectSentTickers([]);
      console.log("[IBKR_DEPTH_RESOLVE]", {
        yahooReturned: candidatePool.length,
        requestedAuditDepth: finalTargetRaw,
        effectiveIbkrLimit: hardEvaluationCap,
        sentToIbkr: Math.min(candidatePool.length, hardEvaluationCap),
        reason:
          Number.isFinite(desiredFromInput)
            ? "finalDisplayedTarget_override"
            : "audit_depth_cap",
      });
      console.warn("[IBKR_AUTO_SEND]", { scanId, source: sourceTag, pool: candidatePool, expirationYmd: expLocked });
      try {
        const payloads = [];
        const testedSymbols = [];
        const retainedSymbols = new Set();
        let cursor = 0;
        while (cursor < hardEvaluationCap && retainedSymbols.size < desiredFinalKept) {
          const remainingToEvaluate = hardEvaluationCap - cursor;
          const batchSize = cursor === 0 ? Math.min(10, remainingToEvaluate) : Math.min(5, remainingToEvaluate);
          const batch = candidatePool.slice(cursor, cursor + batchSize);
          if (!batch.length) break;
          testedSymbols.push(...batch);
          setIbkrDirectSentTickers([...testedSymbols]);
          setRefreshStage(
            `Étape 2/2 : IBKR Direct Scan — ${testedSymbols.length}/${hardEvaluationCap} testés`
          );
          const batchPayload = await callIbkrDirectScan({
            tickers: batch,
            expiration: ymdToIbkr(expLocked),
            clientIdStart: Number(ibkrAutoClientIdStart) + cursor,
            maxTickers: batch.length,
            topN: batch.length,
            auditDepth: finalTarget,
          });
          payloads.push(batchPayload);
          for (const keptRow of Array.isArray(batchPayload?.shortlist) ? batchPayload.shortlist : []) {
            const symbol = String(keptRow?.symbol || "").trim().toUpperCase();
            if (!symbol) continue;
            retainedSymbols.add(symbol);
          }
          cursor += batchSize;
        }
        const payload = mergeIbkrProgressPayloads({
          baseExpiration: expLocked,
          payloads,
          testedSymbols,
          finalDisplayedTarget: finalTarget,
          poolSize: candidatePool.length,
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
          tickersSent: testedSymbols,
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
            setRefreshStage("Timeout IBKR : réduire IBKR Audit Depth. Yahoo/fallback conservé.");
          } else {
            void captureWheelJournalSnapshot({
              candidates: applied,
              scanSessionId: scanId,
              scanTimestamp,
              source: "ibkr_auto_final",
            });
            setIbkrDirectError("");
            setRefreshStage(
              payload.kept >= finalTarget
                ? "Terminé : top trades finaux appliqués après tri live"
                : `Seulement ${payload.kept} retenus IBKR disponibles dans le bassin Yahoo testé.`
            );
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
      ibkrAutoClientIdStart,
      candidateByTickerForPreIbkr,
      selectedExpiration,
      applyIbkrDirectShortlistToPrimary,
      captureWheelJournalSnapshot,
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
    const scanId = formatScanSessionId(new Date());
    const scanTimestamp = new Date().toISOString();
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
      if (payload?.scanTiming && typeof payload.scanTiming === "object") {
        setYahooScanTiming(payload.scanTiming);
      }
      const nextYahooDiagnostics = buildYahooDiagnosticsFromScanPayload(payload, {
        scanned: payload.scanned ?? tickers.length,
        kept: payload.kept ?? mapped.length,
        returned: payload.returned ?? mapped.length,
      });
      setYahooDiagnostics(nextYahooDiagnostics);

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
              yahooDiagnostics: nextYahooDiagnostics,
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
            scanTimestamp,
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
        void captureWheelJournalSnapshot({
          candidates: mapped,
          scanSessionId: scanId,
          scanTimestamp,
          source: "yahoo_final",
        });
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
        setYahooDiagnostics(
          normalizeYahooDiagnosticsForState(cached?.yahooDiagnostics, {
            scanned: cached?.scanMeta?.scanned ?? tagged.length,
            kept: cached?.scanMeta?.kept ?? tagged.length,
            returned: cached?.scanMeta?.returned ?? tagged.length,
          })
        );
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
        setYahooDiagnostics(
          normalizeYahooDiagnosticsForState(null, {
            scanned: tickers.length,
            kept: 0,
            returned: 0,
          })
        );
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
              scanTimestamp,
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
  }, [watchlistTickers, selectedExpiration, topN, autoIbkrDirectScan, rememberTechnicalCandidates, displaySnapshotRef, captureWheelJournalSnapshot]);

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
      const scanSessionId = formatScanSessionId(new Date());
      const scanTimestamp = new Date().toISOString();
      const expLocked = selectedExpirationRef.current;
      const payload = await callIbkrDirectScan({
        tickers: tickersToSend,
        expiration: ymdToIbkr(expLocked),
        clientIdStart: ibkrDirectClientIdStart,
        maxTickers: ibkrDirectMaxTickers,
        topN: ibkrDirectTopN,
        auditDepth: ibkrDirectMaxTickers,
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
          void captureWheelJournalSnapshot({
            candidates: applied,
            scanSessionId,
            scanTimestamp,
            source: "ibkr_manual_final",
          });
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
    captureWheelJournalSnapshot,
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
        auditDepth: 10,
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
    const clamped = Math.min(120, Math.max(10, Number(ibkrAutoMaxTickers) || 20));
    window.localStorage.setItem("wheel.ibkrAuditDepth", String(clamped));
  }, [ibkrAutoMaxTickers]);

  useEffect(() => {
    window.localStorage.setItem("wheel.autoJournalPop", String(autoJournalPop));
  }, [autoJournalPop]);

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
        title: "Retenus IBKR",
        value: String(filtered.length),
        sub: (() => {
          const blocked = filtered.filter(it => {
            const m = getTickerDisplayMeta(String(it?.ticker ?? "").toUpperCase());
            return m.isCryptoBlocked && !m.isCryptoAllowed;
          }).length;
          const admis = filtered.length - blocked;
          if (blocked > 0) return `${admis} admissibles · ${blocked} crypto masqués`;
          return dataSource === "ibkr_direct"
            ? `${scanMeta.returned} retenus IBKR`
            : dataSource === "backend"
            ? `${scanMeta.kept} retenus backend`
            : "snapshot local";
        })(),
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
    [filtered.length, selectedExpiration, dataSource, scanMeta, primaryIbkrSourceInfo, watchlistTickers, watchlistSource, watchlistStats]
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
      <div className="w-full px-2 py-3 md:px-3 lg:px-4">
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

        <div className="mb-6 flex items-center justify-end gap-2">
          <Button
            variant={activeView === "dashboard" ? "default" : "outline"}
            className="rounded-xl"
            onClick={() => setActiveView("dashboard")}
          >
            Dashboard
          </Button>
          <Button
            variant={activeView === "journal" ? "default" : "outline"}
            className="rounded-xl"
            onClick={() => setActiveView("journal")}
          >
            Journal POP <Database className="ml-2 h-4 w-4" />
          </Button>
        </div>

        {activeView === "dashboard" ? (
          <>
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
              max="120"
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

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
            <label className="mb-2 block text-sm font-medium text-slate-700">Auto Journal POP</label>
            <Select
              value={autoJournalPop}
              onChange={(e) => setAutoJournalPop(String(e.target.value || "off"))}
              className="w-full rounded-xl border-slate-200"
            >
              <option value="off">OFF</option>
              <option value="10">Top 10</option>
              <option value="30">Top 30</option>
              <option value="50">Top 50</option>
            </Select>
            <p className="mt-2 text-xs leading-5 text-slate-500">
              Etat actuel : {autoJournalPop === "off" ? "OFF" : `Top ${autoJournalPop}`}.
            </p>
          </div>

          <div>
            <label className="mb-2 block text-sm font-medium text-slate-700">IBKR Audit Depth</label>
            <Select
              value={String(ibkrAutoMaxTickers)}
              onChange={(e) => setIbkrAutoMaxTickers(Number(e.target.value))}
              className="w-full rounded-xl border-slate-200"
              disabled={!autoIbkrDirectScan}
            >
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="30">30</option>
              <option value="50">50</option>
              <option value="120">120</option>
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
            <details open>
              <summary className="cursor-pointer font-semibold text-slate-900">Résumé du funnel</summary>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              <Metric label="Watchlist scannable" value={String(yahooScanMeta.scanned || tickersForScan.length || 0)} />
              <Metric
                label="Cryptos supprimées watchlist"
                value={String(cryptoRemovedFromWatchlistCount)}
                tone={cryptoRemovedFromWatchlistCount > 0 ? "warn" : "default"}
              />
              <Metric label="Yahoo retenus" value={String(yahooScanMeta.kept || 0)} />
              <Metric label="Yahoo retournés" value={String(yahooReturnedCount)} />
              <Metric label="Objectif cartes finales" value={String(ibkrFinalTarget)} />
              <Metric label="IBKR testés" value={String(ibkrTestedCount)} />
              <Metric label="Envoyés à IBKR" value={String(ibkrSentCount)} />
              <Metric label="Retenus IBKR total" value={String(ibkrTotalKeptCollected)} />
              <Metric
                label="Admissibles panneau crème"
                value={String(
                  filtered.length -
                  filtered.filter(it => {
                    const m = getTickerDisplayMeta(String(it?.ticker ?? "").toUpperCase());
                    return m.isCryptoBlocked && !m.isCryptoAllowed;
                  }).length
                )}
              />
              <Metric label="Retenus non affichés après tri" value={String(ibkrRetainedNotDisplayed)} tone={ibkrRetainedNotDisplayed > 0 ? "warn" : "default"} />
              <Metric label="Rejetés IBKR" value={String(ibkrRejectedCount)} />
              <Metric label="Rejetés remplacés" value={String(ibkrRejectedReplaced)} tone={ibkrRejectedReplaced ? "warn" : "default"} />
              <Metric label="Non testés IBKR" value={String(ibkrNonTestedCount)} />
              <Metric
                label="Non envoyés à IBKR"
                value={String(Math.max(0, yahooReturnedCount - ibkrSentCount))}
                tone={yahooReturnedCount > ibkrSentCount ? "warn" : "default"}
              />
              <Metric label="Actionnables Yahoo" value={String(yahooActionabilityCounts.actionable)} tone="good" />
              <Metric label="À surveiller Yahoo" value={String(yahooActionabilityCounts.watch)} tone="warn" />
              <Metric label="Non actionnables Yahoo" value={String(yahooActionabilityCounts.nonActionable)} tone="bad" />
              <Metric label="Actionnables IBKR" value={String(ibkrActionabilityCounts.actionable)} tone="good" />
              <Metric label="À surveiller IBKR" value={String(ibkrActionabilityCounts.watch)} tone="warn" />
              <Metric label="Non actionnables IBKR" value={String(ibkrActionabilityCounts.nonActionable)} tone="bad" />
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Lecture visuelle seulement : actionnable = finalDisplayMode SAFE/AGGRESSIVE avec finalDisplayGrade A/B.
            </p>
            {ibkrDirectResult?.progressiveAutoIbkr && ibkrTotalKeptCollected < ibkrFinalTarget && (
              <p className="mt-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
                Seulement {ibkrTotalKeptCollected} retenus IBKR disponibles dans le bassin Yahoo testé.
              </p>
            )}
            </details>
          </div>
        )}

        {(Number(yahooScanMeta.scanned) > 0 || yahooRejectedCount > 0) && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            <details>
              <summary className="cursor-pointer font-semibold text-slate-900">
                Diagnostic Yahoo (dernier scan)
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Yahoo scanned" value={String(yahooScanMeta.scanned || 0)} />
                <Metric label="Yahoo kept" value={String(yahooScanMeta.kept || 0)} />
                <Metric label="Yahoo returned" value={String(yahooScanMeta.returned || 0)} />
                <Metric label="Yahoo rejected" value={String(yahooRejectedCount)} />
              </div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="font-medium text-slate-900">Top rejectionReasonCounts</p>
                  {yahooTopRejectionReasons.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">Aucun détail disponible.</p>
                  ) : (
                    <div className="mt-2 space-y-1 text-xs text-slate-700">
                      {yahooTopRejectionReasons.map((row) => (
                        <div key={`yahoo-reason-${row.reason}`}>
                          {formatIbkrReason(row.reason)} : {row.count}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
                  <p className="font-medium text-slate-900">Top stageRejectCounts</p>
                  {yahooTopStageRejectCounts.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">Aucun détail disponible.</p>
                  ) : (
                    <div className="mt-2 space-y-1 text-xs text-slate-700">
                      {yahooTopStageRejectCounts.map((row) => (
                        <div key={`yahoo-stage-${row.reason}`}>
                          {formatIbkrReason(row.reason)} : {row.count}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <p className="font-medium text-slate-900">Exemples rejetés (max 20)</p>
                {yahooRejectedSampleRows.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-500">Aucun exemple disponible.</p>
                ) : (
                  <div className="mt-2 space-y-1 text-xs text-slate-700">
                    {yahooRejectedSampleRows.map((row, index) => (
                      <div key={`yahoo-rejected-sample-${row.symbol}-${index}`}>
                        {row.symbol} : {formatIbkrReason(row.reason)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>
        )}

        {yahooReturnedCount > 0 && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            <details>
              <summary className="cursor-pointer font-semibold text-slate-900">Candidats Yahoo non envoyés à IBKR</summary>
            {yahooReturnedCount <= (ibkrTestedCount || Math.min(Number(ibkrAutoMaxTickers) || 20, 120)) ? (
              <p className="mt-2 text-slate-500">
                Impossible d’afficher les rangs 11-30 : /scan_shortlist retourne seulement le Top Yahoo actuel.
              </p>
            ) : yahooNonSentCandidates.length === 0 ? (
              <p className="mt-2 text-slate-500">
                Aucun candidat Yahoo prioritaire non envoyé à IBKR.
              </p>
            ) : (
              <div className="mt-2 space-y-1">
                {yahooNonSentCandidates.map((item) => (
                  <div key={`yahoo-not-sent-${item.ticker ?? item.symbol}`}>
                    Rang Yahoo #{item.rank} · {item.ticker ?? item.symbol} · qualité {item.qualityScore ?? "—"} · RSI{" "}
                    {item.rsi ?? "—"}
                  </div>
                ))}
              </div>
            )}
            </details>
          </div>
        )}

        {ibkrAutoRankDiagnostics.length > 0 && (
          <div className="mb-6 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
            <details>
              <summary className="cursor-pointer font-semibold text-slate-900">
                Rangs Yahoo — testés IBKR : {ibkrTestedCount} / {yahooReturnedCount}
              </summary>
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
              {ibkrAutoRankDiagnostics.map((row) => {
                const symbol = String(row.symbol || "").trim().toUpperCase();
                const tested = ibkrSentSet.has(symbol);
                const rejected = ibkrRejectedSymbols.has(symbol);
                const kept = ibkrKeptSymbols.has(symbol);
                const displayed = ibkrDisplayedSymbols.has(symbol);
                const retainedRow = ibkrRetainedBySymbol.get(symbol);
                const preYahoo = candidateByTickerForPreIbkr.get(symbol) ?? null;
                const mergedForReason =
                  retainedRow != null
                    ? {
                        ...(preYahoo || {}),
                        ...retainedRow,
                        safeStrike: retainedRow?.safeStrike ?? preYahoo?.safeStrike,
                        aggressiveStrike: retainedRow?.aggressiveStrike ?? preYahoo?.aggressiveStrike,
                      }
                    : preYahoo;
                const nonTestedCapReached = !tested && Number(ibkrNonTestedCount) > 0;
                const status = rejected
                  ? "testé puis rejeté"
                  : kept && displayed
                  ? "retenu affiché"
                  : kept && !displayed
                  ? "testé mais non affiché après tri"
                  : nonTestedCapReached
                  ? "non testé car cap IBKR atteint"
                  : tested
                  ? "testé"
                  : "non testé";
                const exclusionReason =
                  kept && !displayed && mergedForReason
                    ? getRetainedNotDisplayedReason(mergedForReason, ibkrDisplayedScoreFloor)
                    : null;
                return (
                  <div key={`pre-ibkr-${row.symbol}`}>
                    {row.selectionMode === "yahoo_shortlist" && row.rank != null
                      ? `${row.symbol} : rang Yahoo #${row.rank} — ${status}${exclusionReason ? ` (${exclusionReason})` : ""} — ${row.reasons.join(" · ") || "ordre shortlist"}`
                      : `${row.symbol} : score ${Math.round(Number(row.score) || 0)} — ${status}${exclusionReason ? ` (${exclusionReason})` : ""} — ${row.reasons.join(" · ") || "base"}`}
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-500">
              Tickers envoyés à IBKR auto : {(ibkrDirectSentTickers || []).join(", ") || "—"}
            </p>
            </details>
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
          yahooScanTiming={yahooScanTiming}
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

              <CardContent className="px-2 py-3 md:px-3">
                {filtered.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-10 text-center text-sm text-slate-500">
                    Aucun résultat avec ce filtre.
                  </div>
                ) : (
                  <>
                    <CremeDeLaCremePanel
                      items={filtered}
                      ibkrBatchByTicker={ibkrBatchByTicker}
                      yahooRankForIbkrBySymbol={yahooRankForIbkrBySymbol}
                      seasonalityMap={seasonalityMap}
                      onOpenDetail={setSelectedItem}
                      highlightedTicker={highlightedTicker}
                    />
                    <p className="mt-3 px-1 text-xs text-slate-500">
                      Les cryptos exclus sont masqués du classement principal. Ils ne sont pas encore remplacés automatiquement par les prochains candidats Yahoo.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <PortfolioCombos combos={combos} capital={Number(capital)} onTickerClick={scrollToTickerCard} />
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
                  {(() => {
                    const cryptoCount = filtered.filter(it => {
                      const m = getTickerDisplayMeta(String(it?.ticker ?? "").toUpperCase());
                      return m.isCryptoBlocked && !m.isCryptoAllowed;
                    }).length;
                    const admis = filtered.length - cryptoCount;
                    return (
                      <>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-slate-500">Retenus IBKR total</span>
                          <span className="font-semibold text-slate-900">{filtered.length}</span>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-slate-500">Admissibles panneau crème</span>
                          <span className="font-semibold text-slate-900">{admis}</span>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-slate-500">Exclus crypto masqués</span>
                          <span className="font-semibold text-slate-900">{cryptoCount}</span>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-slate-500">Non remplacés après exclusion</span>
                          <span className="font-semibold text-amber-600">{cryptoCount}</span>
                        </div>
                      </>
                    );
                  })()}
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
          </>
        ) : (
          <React.Suspense
            fallback={
              <div className="rounded-[28px] border border-slate-200 bg-white p-8 text-sm text-slate-500 shadow-sm">
                Chargement du journal...
              </div>
            }
          >
            <JournalPopPanel apiBase={API_BASE} active={activeView === "journal"} />
          </React.Suspense>
        )}
      </div>

      <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
    </div>
  );
}
