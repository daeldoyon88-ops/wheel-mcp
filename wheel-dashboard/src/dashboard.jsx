import React, { useMemo, useState, useEffect, useCallback, useRef } from "react";
import { motion } from "framer-motion";
import {
  ShieldCheck,
  AlertTriangle,
  CalendarDays,
  Target,
  Search,
  Activity,
  Layers3,
  X,
  RefreshCw,
  Database,
  PieChart,
  Settings,
  Server,
  Info,
  MoreHorizontal,
  ChevronRight,
} from "lucide-react";
import { wheelShortlist } from "./data/wheelShortlist";
import {
  buildOtmPoolSourceBannerMessage,
  buildOtmRebuildRequiredMessage,
  buildPreIbkrCutTickerList,
  buildTickerPipelineDiagnostic,
  buildWatchlistRejectedBySymbol,
  buildYahooIbkrFunnel,
  buildYahooRejectedBySymbol,
  isOtmRebuildRequired,
  normalizeTickerQueryForDiagnostic,
  summarizePreIbkrCutByCategory,
  summarizeYahooIbkrFunnel,
} from "./tickerPipelineDiagnostic.js";
import { buildScanFunnelArchivePayload } from "./scanFunnelArchivePayload.js";
import {
  FUNNEL_ARCHIVE_STAGE_ORDER,
  buildFunnelSessionSummary,
  formatFunnelArchiveTimestamp,
  funnelArchiveCount,
  funnelStageLabel,
  getTickerFunnelChain,
  groupSymbolsByStage,
  isFunnelArchiveComplete,
  normalizeFunnelTickerQuery,
} from "./scanFunnelArchiveUi.js";
import {
  normalizeExpirationKey,
  candidateRowMatchesSelectedExpiration,
} from "./expirationKey.js";
import {
  buildExpirationOptions,
  getAdjustedExpirationForClosedMarket,
} from "./marketCalendar.js";
import { SeasonalityBadge } from "./components/SeasonalityBadge.jsx";
import { getTickerDisplayMeta, QUALITY_TIER_STYLE, USER_PREFS, CRYPTO_BLOCK_REASON } from "./tickerMeta.js";
import { isCryptoDigitalAssetBlocked } from "../../app/watchlist/cryptoWheelFilter.js";
import {
  buildPortfolioCombos,
  buildCapitalComboCandidate,
  computeTickerQualityOverlay,
  getAggressivePriorityGrade,
  getFinalDisplayRecommendation,
  getLegDistancePct,
  getLegPopPct,
  getLegPremiumValue,
  getLegSpreadPct,
  getLegYieldPct,
  getCandidateExecutionScore,
  getLegExecutionBreakdown,
  CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE,
  getModeGradeRank,
  gradeLeg,
  isUnknownUnvalidatedTicker,
  MODE_GRADE_RANK,
} from "./capitalComboPortfolio.js";
import { formatCapBlockerReason } from "./capitalComboEngineV2.js";
import { buildSupportResistanceV4ConfirmedZones } from "../../app/scanners/supportResistanceV4ConfirmedZones.js";
import {
  applyResearchExpandedFlagsToCandidates,
  applyResearchExpandedPinnedTickers,
  buildIbkrAutoNetworkSkipMessage,
  buildIbkrAutoSkipMessage,
  buildStrictWatchlistEmptyInfo,
  formatPoolSourceLabel,
  loadResearchExpandedPoolWithFallback,
  readStoredPreIbkrPoolMode,
  readStoredResearchExpandedLimit,
  resolvePreIbkrTickers,
} from "./preIbkrPool.js";
import {
  attemptSafeSpreadRescue,
  getActiveSpreadPctForSelectedMode,
  shouldGlobalSpreadReject,
} from "../../app/calculations/safeSpreadRescue.js";
import { computeScoreV2 } from "./scoreV2.js";

const API_BASE = "http://127.0.0.1:3001";
const JournalPopPanel = React.lazy(() => import("./components/JournalPopPanel.jsx"));
const SeasonalityPanel = React.lazy(() => import("./components/SeasonalityPanel.jsx"));

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
/** Valeurs par défaut déjà ajustées : un vendredi férié (ex. Juneteenth) est remplacé par le jeudi ouvert. */
const DEFAULT_EXPIRATION_VALUES = DEFAULT_EXPIRATIONS.map(
  (e) => getAdjustedExpirationForClosedMarket(e).adjusted || e
);
const DEBUG_COMPARE = false;
const DEBUG_DTE_RESOLVE = false;

/** Liste statique conservée uniquement en secours si /universe/build échoue ou est indisponible. */
const FALLBACK_TICKERS = [
  "CF", "SNOW", "KO", "SLB", "TSCO", "PCG", "DOCU", "PATH", "F", "WBD",
  "BITX", "SOFI", "ABT", "SCHW", "CSX", "NDAQ", "BAC", "CVS", "GM", "HIMS",
  "UBER", "TGT", "AFRM", "SBUX", "NFLX", "TQQQ", "SOXL", "TNA", "SSO", "EXPE", "SHOP", "AAPL",
  "AMZN", "AMD", "ORCL", "PLTR", "NVDA", "MSFT", "GOOGL", "MU", "AVGO", "TSM",
  "MRVL", "IBKR", "DUOL", "RYAAY", "NEM", "DELL", "KMI", "HOOD", "LVS", "TW",
  "NI", "FSLR", "INCY", "NBIX", "ROOT", "VST", "TECK", "ZM", "PYPL", "DECK",
  "NVO", "PHM", "DXCM", "USB", "PDD"
];

/** Libellé UI pour strict_watchlist | research_expanded | fallback_65 */
function getPoolModeLabel(modeOrSource) {
  return formatPoolSourceLabel(modeOrSource);
}

/** Nombre de tickers du pool actuellement sélectionné (pas le dernier scan). */
function getCurrentPoolCount({ resolvedPreIbkrPool, tickersForScan, preIbkrPoolMode }) {
  if (Array.isArray(tickersForScan)) {
    return tickersForScan.length;
  }
  if (Array.isArray(resolvedPreIbkrPool?.tickers)) {
    return resolvedPreIbkrPool.tickers.length;
  }
  if (preIbkrPoolMode === "fallback_65") {
    return FALLBACK_TICKERS.length;
  }
  return 0;
}

/** True si le mode sélectionné diffère du pool du dernier scan. */
function isLastScanPoolStale({ preIbkrPoolMode, lastScanPoolMeta }) {
  const lastSource = String(lastScanPoolMeta?.poolSource || "").trim();
  if (!lastSource) return false;
  return preIbkrPoolMode !== lastSource;
}

function hasRecentScanPoolMeta(lastScanPoolMeta) {
  return Boolean(String(lastScanPoolMeta?.poolSource || "").trim());
}

/** Message fallback diagnostics — volontaire vs secours involontaire. */
function buildFallbackPoolDiagnosticMessage({ preIbkrPoolMode, lastScanPoolMeta, isStale }) {
  const lastSource = lastScanPoolMeta?.poolSource;
  if (lastSource !== "fallback_65") return null;
  if (isStale) return null;
  if (preIbkrPoolMode === "fallback_65") {
    return {
      tone: "neutral",
      text: "Fallback sélectionné manuellement — pool statique utilisé.",
    };
  }
  if (lastScanPoolMeta.usedFallbackUltimate) {
    return {
      tone: "warn",
      text: "Research Expanded indisponible — secours fallback utilisé.",
    };
  }
  return null;
}

/** Aligné sur ton backend (schema zod dans server.js) — à ajuster si tes critères changent. */
const DEFAULT_BUILD_WATCHLIST_BODY = {
  /** Plafond spot CSP : 200 couvre plus de noms institutionnels tout en restant sous beaucoup de caps 25,5k$/contrat. */
  maxPrice: 200,
  minPrice: 10,
  /** V2 relaxed : abaissé de 1 000 000 à 500 000 pour inclure les mid-caps solides (300k-800k ADV). */
  minVolume: 500_000,
  maxContractCapital: 25_500,
  minMarketCapB: 5,
  /** true : tente le fetch options pour scorer ; en mode relaxed, les échecs Yahoo deviennent des pénalités de score plutôt que des rejets durs. */
  requireLiquidOptions: true,
  requireWeeklyOptions: true,
  /** % OTM minimal pour la sonde (défaut serveur 5 si omis). Mettre 0 pour désactiver uniquement la sonde OTM tout en gardant ATM. */
  liquidityOtmProbePct: 5,
  /** high_premium : bassin élargi ; etf volontairement absent par défaut (junk/leverage à activer au besoin). */
  categories: ["weekly", "core", "growth", "high_premium"],
  limit: 150,
  /** "relaxed" : weekly/liquidity Yahoo = pénalités (−10/−12/−15/−8) au lieu de rejets durs. Score plancher 20. */
  watchlistMode: "relaxed",
};

/** Niveaux pour comparer la sonde OTM Yahoo sur la watchlist (si `requireLiquidOptions`). */
const LIQUIDITY_OTM_PROBE_PCT_CHOICES = Object.freeze([0, 3, 4, 5, 6]);

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
    body: "Le compteur Watchlist et le scan utilisent /universe/build (options liquides Yahoo : ATM + sonde OTM) avec la liste weekly TradingView quand le backend répond ; la liste statique sert de secours.",
  },
];

const verdictStyle = {
  conservative: "bg-emerald-950/50 text-emerald-400 border-emerald-800",
  balanced: "bg-amber-950/50 text-amber-400 border-amber-800",
  aggressive: "bg-rose-950/50 text-rose-400 border-rose-800",
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

function minPremiumForSpot(spot, dteDays) {
  if (!spot || spot <= 0) return 0;
  // Aligné sur backend wheelMetrics.js : spot * 0.5% * max(1, dteDays/7)
  return spot * 0.005 * Math.max(1, (dteDays ?? 7) / 7);
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


function computeModeRecommendation({
  safeStrike,
  aggressiveStrike,
  lowerBound,
  spot,
  hasUpcomingEarningsBeforeExpiration,
  hasEarningsBeforeExpiration,
  earningsDaysUntil,
  safeSpreadRescueDiagnostics = null,
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
      ...(safeSpreadRescueDiagnostics && typeof safeSpreadRescueDiagnostics === "object"
        ? safeSpreadRescueDiagnostics
        : {}),
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
  return normalizeExpirationKey(value);
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

function clampPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function ratioPct(part, total) {
  const p = Number(part);
  const t = Number(total);
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0;
  return clampPct((p / t) * 100);
}

function sumCountsByKeys(countsLike, keys = []) {
  const counts = normalizeCountMap(countsLike);
  return keys.reduce((sum, key) => sum + (Number(counts[key]) || 0), 0);
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

/** Extrait les index diagnostic watchlist depuis le payload /universe/build. */
function extractWatchlistBuildDiagnostics(payload) {
  const rejectedRows = Array.isArray(payload?.rejected) ? payload.rejected : [];
  const truncatedSymbols = Array.isArray(payload?.stats?.truncatedSymbols)
    ? payload.stats.truncatedSymbols
    : [];
  return {
    watchlistRejectedRows: rejectedRows,
    watchlistTruncatedSymbols: truncatedSymbols,
    watchlistRejectedBySymbol: buildWatchlistRejectedBySymbol({ rejectedRows, truncatedSymbols }),
  };
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
      if (maxDays == null) return true;
      const days = daysBetweenYmd(today, d);
      return days != null && days >= 0 && days <= maxDays;
    })
    .sort();
  return candidates[0] || null;
}

function isYmdDate(value) {
  return isYmd(value);
}

function resolveRelevantEarningsDateForItem(item) {
  return pickRelevantEarningsDate({
    earningsDate: item?.earningsDate ?? item?.raw?.earningsDate ?? null,
    nextEarningsDate: item?.nextEarningsDate ?? item?.raw?.nextEarningsDate ?? null,
    expiration: item?.targetExpiration ?? item?.expiration ?? item?.raw?.expiration ?? null,
    maxDays: null,
  });
}

function isEarningsBeforeExpirationForItem(item) {
  if (resolveRelevantEarningsDateForItem(item)) return true;
  if (item?.hasUpcomingEarningsBeforeExpiration !== true) return false;
  const expiration = item?.targetExpiration ?? item?.expiration ?? item?.raw?.expiration ?? null;
  const today = ymdTodayLocal();
  for (const d of [
    item?.nextEarningsDate ?? item?.raw?.nextEarningsDate,
    item?.earningsDate ?? item?.raw?.earningsDate,
  ]) {
    if (isYmd(d) && isYmd(expiration) && String(d) >= String(today) && String(d) <= String(expiration)) {
      return true;
    }
  }
  return false;
}

function getSafeEarningsDaysUntil(item) {
  const relevant = resolveRelevantEarningsDateForItem(item);
  if (!relevant) return null;
  const days = daysBetweenYmd(ymdTodayLocal(), relevant);
  return days != null && days >= 0 ? days : null;
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
  let safe = item?.ibkrSafeStrike ?? item?.safeStrike ?? null;
  const aggressive = item?.ibkrAggressiveStrike ?? item?.aggressiveStrike ?? item?.maxPremiumStrike ?? null;
  const putCandidatesForRescue =
    item?.putCandidates ?? item?.raw?.putCandidates ?? item?.ibkr?.putCandidates ?? [];
  const safeSpreadRescueFromIbkr = item?.safeSpreadRescue ?? item?.raw?.safeSpreadRescue ?? null;
  const alreadyRescuedByIbkr =
    safe?.safeSpreadRescueApplied === true || safeSpreadRescueFromIbkr?.safeSpreadRescueTriggered === true;
  const safeSpreadRescueResult = attemptSafeSpreadRescue({
    safeStrike: safe,
    aggressiveStrike: aggressive,
    putCandidates: putCandidatesForRescue,
    lowerBound: item?.lowerBound ?? item?.expectedMoveLow ?? null,
    targetPremium: item?.targetPremium ?? item?.minPremium ?? null,
    spot: item?.currentPrice ?? item?.underlyingPrice ?? item?.price ?? null,
    allStrikes: putCandidatesForRescue.map((p) => p?.strike).filter((s) => s != null),
    skipIfAlreadyRescued: alreadyRescuedByIbkr,
  });
  safe = safeSpreadRescueResult.safeStrike ?? safe;
  const safeSpreadRescueDiagnostics =
    safeSpreadRescueFromIbkr ??
    safeSpreadRescueResult.diagnostics ??
    safe?.safeSpreadRescueDiagnostics ??
    null;
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
    safeSpreadRescueDiagnostics,
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
    minPremium: item.targetPremium ?? minPremiumForSpot(item.currentPrice ?? 0, item.dteDays),
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
    safeSpreadRescue: safeSpreadRescueDiagnostics,
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
    supportStatusLegacy: item.supportStatusLegacy ?? item.supportResistance?.supportStatus ?? null,
    supportStatusV2: item.supportStatusV2 ?? null,
    supportScoringV2:
      item.supportScoringV2 && typeof item.supportScoringV2 === "object"
        ? { ...item.supportScoringV2 }
        : null,
    supportStatusUsedByQualityScore: item.supportStatusUsedByQualityScore ?? null,
    strikeVsSupportEffectivePct: item.strikeVsSupportEffectivePct ?? null,
    qualityScoreDeltaLegacyVsV2: item.qualityScoreDeltaLegacyVsV2 ?? null,
    supportDiagnosticsV1:
      item.supportDiagnosticsV1 && typeof item.supportDiagnosticsV1 === "object"
        ? { ...item.supportDiagnosticsV1 }
        : null,
    supportResistanceV4:
      item.supportResistanceV4 && typeof item.supportResistanceV4 === "object"
        ? { ...item.supportResistanceV4 }
        : null,
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



function Card({ className = "", children }) {
  return <div className={cn("rounded-2xl border border-slate-700/60 bg-slate-900", className)}>{children}</div>;
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
  return (
    <input
      {...props}
      className={cn(
        "rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none placeholder:text-slate-500 focus:border-slate-500",
        className
      )}
    />
  );
}

function Select({ className = "", children, ...props }) {
  return (
    <select
      {...props}
      className={cn(
        "rounded-xl border border-slate-600 bg-slate-800 px-3 py-2 text-slate-100 outline-none focus:border-slate-500",
        className
      )}
    >
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
      ? "border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700"
      : "border border-sky-700 bg-sky-900 text-sky-100 hover:bg-sky-800";
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
    <div className="h-2 w-full rounded-full bg-slate-700">
      <div
        className="h-2 rounded-full bg-sky-500"
        style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }}
      />
    </div>
  );
}

function StatCard({ item }) {
  const Icon = item.icon;

  return (
    <Card className="border-slate-700/60 shadow-sm">
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm text-slate-400">{item.title}</p>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-100">{item.value}</p>
            <p className="mt-1 text-sm text-slate-400">{item.sub}</p>
          </div>
          <div className="rounded-2xl bg-slate-800 p-3">
            <Icon className="h-5 w-5 text-slate-300" />
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
              ? "border-rose-800 bg-rose-950/40"
              : "border-emerald-800 bg-emerald-950/40"
          )}
        >
          <CardContent className="p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-xl bg-slate-800/80 p-2">
                {alert.type === "earnings" ? (
                  <AlertTriangle className="h-4 w-4 text-rose-400" />
                ) : (
                  <ShieldCheck className="h-4 w-4 text-emerald-400" />
                )}
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-100">{alert.title}</p>
                <p className="mt-1 text-sm leading-6 text-slate-300">{alert.body}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Format diagnostic d'un ratio en pourcentage ; "—" si le dénominateur est nul/invalide. */
function formatDiagPct(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return "—";
  return `${((n / d) * 100).toFixed(1)} %`;
}

/** Variante avec libellé court de dénominateur ("X % scannés"), neutre quand le ratio vaut "—". */
function formatDiagPctOf(numerator, denominator, base) {
  const pct = formatDiagPct(numerator, denominator);
  return base && pct !== "—" ? `${pct} ${base}` : pct;
}

function Metric({ label, value, strong = false, tone = "default", sub = null }) {
  const toneClass =
    tone === "good"
      ? "bg-emerald-950/40 border-emerald-800 text-emerald-300"
      : tone === "warn"
      ? "bg-amber-950/40 border-amber-800 text-amber-300"
      : tone === "bad"
      ? "bg-rose-950/40 border-rose-800 text-rose-300"
      : "bg-slate-800/50 border-slate-700 text-slate-200";

  return (
    <div className={cn("rounded-xl border p-3", toneClass)}>
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={cn("mt-1 text-sm", strong && "font-semibold")}>{value}</p>
      {sub ? <p className="mt-0.5 text-xs text-slate-500">{sub}</p> : null}
    </div>
  );
}

// Layout-only wrapper for the Diagnostics page. No business logic, no mutation,
// no API call — it only groups already-rendered blocks under a titled section.
function DiagnosticsSection({ eyebrow, title, description, children }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-950/40 p-4 shadow-sm">
      <div className="mb-3">
        {eyebrow && (
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-300/80">
            {eyebrow}
          </p>
        )}
        <h2 className="mt-1 text-lg font-semibold text-white">{title}</h2>
        {description && (
          <p className="mt-1 text-sm text-slate-400">{description}</p>
        )}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
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
    ? "border border-amber-700 bg-amber-950/40 text-amber-300"
    : "border border-emerald-300 bg-emerald-950/40 text-emerald-300";
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
  const [chartOptionsOpen, setChartOptionsOpen] = useState(false);
  const [chartOptions, setChartOptions] = useState({
    showSpot: true,
    showSelectedStrike: true,
    showSafeStrike: true,
    showExpectedMove: true,
    showClassicSupports: true,
    showClassicResistances: true,
    showV4Zones: true,
    showWideSupport: true,
    lineStyle: "dashed",
    lineWidth: "normal",
    priceLineStyle: "standard",
    labelDensity: "normal",
    palette: "defensive",
    periodDays: 60,
    scaleMode: "tradeFocus",
    priceMode: "linear",
  });
  const closes = Array.isArray(item?.priceSeries?.closes)
    ? item.priceSeries.closes.map(Number).filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const rawDates = Array.isArray(item?.priceSeries?.dates)
    ? item.priceSeries.dates
    : Array.isArray(item?.priceSeries?.timestamps)
    ? item.priceSeries.timestamps
    : [];
  const requestedDays = chartOptions.periodDays;
  const visibleCloses = closes.slice(-requestedDays);
  const actualDays = visibleCloses.length;
  const dataLimitedForPeriod = requestedDays > actualDays;
  const visibleDates = rawDates.slice(-actualDays);
  const price = Number(item?.price);
  const safeStrike = Number(item?.safeStrike?.strike);
  const safeMid = Number(item?.safeStrike?.mid ?? item?.safeStrike?.premiumUsed);
  const expectedMoveLow = Number(item?.expectedMoveLow);
  const expectedMoveHigh = Number(item?.expectedMoveHigh);
  const supportNear = Number(item?.supportNear);
  const supportWide = Number(item?.supportWide ?? item?.support);
  // S. large excluded from scale when >25% below spot to prevent it from crushing the vertical axis;
  // it stays in levelRows for the legend.
  const supportWideForScale =
    Number.isFinite(supportWide) && Number.isFinite(price) && price > 0 && supportWide < price * 0.75
      ? NaN
      : supportWide;
  const potentialSupport =
    Number(item?.potentialSupportFromBrokenResistance) ||
    (item?.resistanceStatus === "broken" ? Number(item?.resistanceCurrent ?? item?.resistance) : NaN);
  const resistanceAboveSpot = Number(item?.resistanceAboveSpot ?? item?.resistanceCurrent ?? item?.resistance);
  // Extract V4 zone numerics early for Trade Focus Scale (before scale computation)
  const v4DataRaw = item?.supportResistanceV4;
  const v4SupportZoneRaw =
    v4DataRaw?.strikeProtectionV4?.selectedSupportZone != null
      ? v4DataRaw.strikeProtectionV4.selectedSupportZone
      : v4DataRaw?.bestSupportZone ?? null;
  const v4ResistanceZoneRaw = v4DataRaw?.bestResistanceZone ?? null;
  const v4StrikeNumForFocus = Number(v4DataRaw?.strike);
  const v4StrikeForFocus =
    Number.isFinite(v4StrikeNumForFocus) && v4StrikeNumForFocus > 0 ? v4StrikeNumForFocus : NaN;
  const v4SupportLowFocus = Number(v4SupportZoneRaw?.zoneLow);
  const v4SupportHighFocus = Number(v4SupportZoneRaw?.zoneHigh);
  const v4ResistanceLowFocus = Number(v4ResistanceZoneRaw?.zoneLow);
  const v4ResistanceHighFocus = Number(v4ResistanceZoneRaw?.zoneHigh);

  const hasSeries = visibleCloses.length >= 2;

  // Scale source selection based on scaleMode
  const tradeFocusLevelValues = [
    price, safeStrike, expectedMoveLow, expectedMoveHigh, supportNear,
    resistanceAboveSpot,
    chartOptions.showWideSupport ? supportWideForScale : NaN,
    potentialSupport, v4StrikeForFocus,
    v4SupportLowFocus, v4SupportHighFocus, v4ResistanceLowFocus, v4ResistanceHighFocus,
  ].filter((v) => Number.isFinite(v) && v > 0);

  let scaleSource;
  if (chartOptions.scaleMode === "auto") {
    const enabledLevels = [
      chartOptions.showSpot ? price : NaN,
      chartOptions.showSafeStrike ? safeStrike : NaN,
      chartOptions.showExpectedMove ? expectedMoveLow : NaN,
      chartOptions.showExpectedMove ? expectedMoveHigh : NaN,
      chartOptions.showClassicSupports ? supportNear : NaN,
      chartOptions.showClassicSupports ? potentialSupport : NaN,
      chartOptions.showClassicResistances ? resistanceAboveSpot : NaN,
      chartOptions.showWideSupport ? supportWide : NaN,
      chartOptions.showSelectedStrike ? v4StrikeForFocus : NaN,
      chartOptions.showV4Zones ? v4SupportLowFocus : NaN,
      chartOptions.showV4Zones ? v4SupportHighFocus : NaN,
      chartOptions.showV4Zones ? v4ResistanceLowFocus : NaN,
      chartOptions.showV4Zones ? v4ResistanceHighFocus : NaN,
    ].filter((v) => Number.isFinite(v) && v > 0);
    const src = [...visibleCloses, ...enabledLevels].filter((v) => Number.isFinite(v) && v > 0);
    scaleSource = src.length >= 2 ? src : [price, safeStrike].filter((v) => Number.isFinite(v) && v > 0);
  } else if (chartOptions.scaleMode === "full") {
    // Complet: Y axis follows the price curve only — levels are drawn but don't distort scale
    const src = visibleCloses.filter((v) => Number.isFinite(v) && v > 0);
    scaleSource = src.length >= 2 ? src : [price, safeStrike].filter((v) => Number.isFinite(v) && v > 0);
  } else {
    // tradeFocus (default): trade-relevant levels, S. large clamped, fallback to closes
    scaleSource = tradeFocusLevelValues.length >= 2
      ? tradeFocusLevelValues
      : [...visibleCloses, price, safeStrike].filter((v) => Number.isFinite(v) && v > 0);
  }

  const rawMin = scaleSource.length ? Math.min(...scaleSource) : 0;
  const rawMax = scaleSource.length ? Math.max(...scaleSource) : 1;
  const rawRange = rawMax - rawMin || Math.max(rawMax * 0.08, 1);
  const padding = Math.max(rawRange * 0.08, rawMax * 0.02);
  const min = rawMin - padding;
  const max = rawMax + padding;
  const range = max - min || 1;
  const width = 640;
  const height = 420;
  const padLeft = 44;
  const padRight = 36;
  const padTop = 12;
  const padBottom = 28;
  const chartWidth = width - padLeft - padRight;
  const chartHeight = height - padTop - padBottom;
  const xForIndex = (index) =>
    padLeft + (visibleCloses.length <= 1 ? 0 : (index / (visibleCloses.length - 1)) * chartWidth);
  // logFeasible uses rawMin (unpadded): linear padding can push min to ≤ 0 for low-priced stocks
  const logFeasible = chartOptions.priceMode === "log" && rawMin > 0 && rawMax > 0;
  if (chartOptions.priceMode === "log" && !logFeasible) console.warn("[MiniChart] log impossible (prix ≤ 0), fallback linéaire.");
  // Multiplicative boundaries keep all price data inside the clip area regardless of linear padding
  const _logMin = logFeasible ? Math.log(rawMin * 0.90) : 0;
  const _logMax = logFeasible ? Math.log(rawMax * 1.10) : 1;
  const _logRange = (_logMax - _logMin) || 1;
  const yForValue = logFeasible
    ? (value) => { const lv = value > 0 ? Math.log(value) : _logMin; return padTop + ((_logMax - lv) / _logRange) * chartHeight; }
    : (value) => padTop + ((max - value) / range) * chartHeight;
  const points = visibleCloses
    .map((value, index) => `${xForIndex(index).toFixed(1)},${yForValue(value).toFixed(1)}`)
    .join(" ");
  if (typeof window !== "undefined" && window.location?.hostname === "localhost") {
    console.debug("[mini-chart-scale]", {
      ticker: item?.ticker,
      periodDays: requestedDays,
      actualCandlesCount: actualDays,
      scaleMode: chartOptions.scaleMode,
      priceMode: chartOptions.priceMode,
      logFeasible,
      rawMin: rawMin.toFixed(3),
      rawMax: rawMax.toFixed(3),
      yMin: min.toFixed(3),
      yMax: max.toFixed(3),
    });
  }
  const chartPalettes = {
    standard: {
      spot: "#00c8ff",
      safeStrike: "#ff273a",
      selectedStrike: "#f59e0b",
      expectedMoveHigh: "#ff9f0a",
      expectedMoveLow: "#ffb21a",
      supportNear: "#21ff7a",
      potentialSupport: "#10d6a3",
      wideSupport: "#26e6c2",
      resistance: "#c76bff",
      supportV4: "#21ff7a",
      resistanceV4: "#c76bff",
      priceLine: "#00a9ff",
    },
    defensive: {
      spot: "#00c8ff",
      safeStrike: "#7ec8e3",
      selectedStrike: "#f59e0b",
      expectedMoveHigh: "#fbbf24",
      expectedMoveLow: "#fbbf24",
      supportNear: "#22c55e",
      potentialSupport: "#2dd4bf",
      wideSupport: "#0d9488",
      resistance: "#a855f7",
      supportV4: "#16a34a",
      resistanceV4: "#7c3aed",
      priceLine: "#38bdf8",
    },
    contrast: {
      spot: "#e0f7ff",
      safeStrike: "#bfdbfe",
      selectedStrike: "#fb923c",
      expectedMoveHigh: "#facc15",
      expectedMoveLow: "#facc15",
      supportNear: "#4ade80",
      potentialSupport: "#34d399",
      wideSupport: "#94a3b8",
      resistance: "#e879f9",
      supportV4: "#86efac",
      resistanceV4: "#d8b4fe",
      priceLine: "#67e8f9",
    },
  };
  const pal = chartPalettes[chartOptions.palette] ?? chartPalettes.defensive;

  const levelRows = [
    { label: "EM haut", value: expectedMoveHigh, color: pal.expectedMoveHigh },
    { label: "Résistance sup.", value: resistanceAboveSpot, color: pal.resistance },
    { label: "Spot", value: price, color: pal.spot },
    { label: "S. proche", value: supportNear, color: pal.supportNear },
    { label: "Strike safe", value: safeStrike, color: pal.safeStrike },
    { label: "EM bas", value: expectedMoveLow, color: pal.expectedMoveLow },
    { label: "S. potentiel", value: potentialSupport, color: pal.potentialSupport },
    { label: "S. large", value: supportWide, color: pal.wideSupport },
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
  // Adaptive tick step: handles small prices (SOFI ~$15) and large prices (TQQQ ~$74)
  const niceTickSteps = [0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100];
  const rawTickStep = (max - min) / 8;
  const tickStep = niceTickSteps.find((s) => s >= rawTickStep) ?? 100;
  const formatTick = (v) => {
    if (v % 1 === 0) return String(Math.round(v));
    return tickStep < 1 ? v.toFixed(2) : v.toFixed(1);
  };
  let yTicks;
  if (logFeasible) {
    const logTicks = [];
    const mag = Math.pow(10, Math.floor(Math.log10(rawMin)));
    for (let m = mag; m <= rawMax * 2; m *= 10) {
      for (const mult of [1, 2, 5]) {
        const v = Math.round(m * mult * 100) / 100;
        if (v >= rawMin * 0.95 && v <= rawMax * 1.05) logTicks.push(v);
      }
    }
    if (logTicks.length < 2) {
      // Fallback: linear ticks when log decade spacing gives too few points
      const fbStep = niceTickSteps.find((s) => s >= (rawMax - rawMin) / 6) ?? 1;
      const fbStart = Math.ceil(rawMin / fbStep) * fbStep;
      const fbCount = Math.floor((rawMax - fbStart) / fbStep) + 1;
      Array.from({ length: Math.max(0, fbCount) }, (_, i) =>
        Math.round((fbStart + i * fbStep) * 10000) / 10000
      )
        .filter((v) => v >= rawMin * 0.95 && v <= rawMax * 1.05)
        .forEach((v) => { if (!logTicks.includes(v)) logTicks.push(v); });
    }
    yTicks = logTicks.length > 14 ? logTicks.filter((_, i) => i % 2 === 0) : logTicks;
  } else {
    const tickStart = Math.ceil(min / tickStep) * tickStep;
    const tickCount = Math.floor((max - tickStart) / tickStep) + 1;
    const allYTicks = Array.from({ length: Math.max(0, tickCount) }, (_, i) =>
      Math.round((tickStart + i * tickStep) * 10000) / 10000
    ).filter((v) => v >= min - 0.0001 && v <= max + 0.0001);
    yTicks = allYTicks.length > 14 ? allYTicks.filter((_, i) => i % 2 === 0) : allYTicks;
  }
  const monthLabels = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  const parseChartDate = (raw) => {
    if (raw == null) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  };
  const formatChartDate = (date) => `${date.getDate()} ${monthLabels[date.getMonth()]}`;
  const fallbackEndDate = parseChartDate(item?.asOf ?? item?.raw?.asOf ?? item?.scanTimestamp) ?? new Date();
  const xTickInterval = Math.max(1, Math.floor((visibleCloses.length - 1) / 8));
  const xTickIndexes = Array.from({ length: 9 }, (_, i) => Math.min(i * xTickInterval, visibleCloses.length - 1))
    .filter((index, pos, arr) => index >= 0 && index < visibleCloses.length && arr.indexOf(index) === pos);
  const xTicks = xTickIndexes.map((index) => {
    const parsed = parseChartDate(visibleDates[index]);
    const approx = new Date(fallbackEndDate);
    approx.setDate(fallbackEndDate.getDate() - (visibleCloses.length - 1 - index));
    return {
      index,
      label: formatChartDate(parsed ?? approx),
    };
  });

  const v4Data = item?.supportResistanceV4;
  const v4SelectedSupport =
    v4Data?.strikeProtectionV4?.selectedSupportZone != null
      ? v4Data.strikeProtectionV4.selectedSupportZone
      : v4Data?.bestSupportZone ?? null;
  const v4Resistance = v4Data?.bestResistanceZone ?? null;
  const v4StrikeNum = Number(v4Data?.strike);
  const v4Strike = Number.isFinite(v4StrikeNum) && v4StrikeNum > 0 ? v4StrikeNum : null;

  const isZoneDrawable = (zone) => {
    if (!zone) return false;
    const low = Number(zone.zoneLow);
    const high = Number(zone.zoneHigh);
    if (!Number.isFinite(low) || !Number.isFinite(high) || low <= 0 || high <= 0) return false;
    return high >= min * 0.98 && low <= max * 1.02;
  };

  const drawSupport = isZoneDrawable(v4SelectedSupport);
  const drawResistance = isZoneDrawable(v4Resistance);
  const drawStrike = v4Strike !== null && v4Strike >= min * 0.92 && v4Strike <= max * 1.08;

  const filteredLevelRows = levelRows.filter((row) => {
    if (row.label === "Spot" && !chartOptions.showSpot) return false;
    if (row.label === "Strike safe" && !chartOptions.showSafeStrike) return false;
    if ((row.label === "EM haut" || row.label === "EM bas") && !chartOptions.showExpectedMove) return false;
    if ((row.label === "S. proche" || row.label === "S. potentiel") && !chartOptions.showClassicSupports) return false;
    if (row.label === "Résistance sup." && !chartOptions.showClassicResistances) return false;
    if (row.label === "S. large" && !chartOptions.showWideSupport) return false;
    return true;
  });
  const showV4Support = drawSupport && chartOptions.showV4Zones;
  const showV4Resistance = drawResistance && chartOptions.showV4Zones;
  const showV4Strike = drawStrike && chartOptions.showSelectedStrike;
  const levelStrokeDasharray = chartOptions.lineStyle === "solid" ? undefined : "7 7";
  const levelStrokeWidth = chartOptions.lineWidth === "fine" ? 1.2 : chartOptions.lineWidth === "thick" ? 2.2 : 1.5;
  const v4StrokeDasharray = chartOptions.lineStyle === "solid" ? undefined : "4 4";
  const priceStrokeWidth = chartOptions.priceLineStyle === "visible" ? 2.6 : chartOptions.priceLineStyle === "muted" ? 1.2 : 1.9;
  const priceOpacity = chartOptions.priceLineStyle === "muted" ? 0.55 : 1;
  const legendGapClass = chartOptions.labelDensity === "compact" ? "gap-1" : "gap-2";
  const legendTextClass = chartOptions.labelDensity === "compact" ? "text-xs" : "text-sm";

  return (
    <div className="flex flex-col rounded-[8px] border border-[#172637] bg-[#020811] p-3 text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_24px_rgba(0,170,255,0.035)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wide text-white">Mini carte technique — {actualDays} dernières séances</p>
          <p className="mt-1 text-xs text-slate-400">
            Niveaux trade / supports / expected move.
          </p>
          {dataLimitedForPeriod && (
            <p className="mt-0.5 text-[10px] text-amber-500/80">Données disponibles : {actualDays} séances sur {requestedDays} demandées.</p>
          )}
          {!dataLimitedForPeriod && requestedDays > 60 && (
            <p className="mt-0.5 text-[10px] text-slate-500/70">Niveaux V4 figés au scan — non mis à jour par la période.</p>
          )}
          <button
            type="button"
            onClick={() => setChartOptionsOpen((prev) => !prev)}
            className="mt-1.5 flex items-center gap-1 rounded-[5px] border border-[#1a3347] bg-[#071420] px-2 py-0.5 text-[11px] text-slate-400 transition-colors hover:border-[#2a5070] hover:text-slate-200"
          >
            Options mini carte {chartOptionsOpen ? "▴" : "▾"}
          </button>
        </div>
        <Badge className="rounded-full border border-fuchsia-700 bg-fuchsia-950/70 text-fuchsia-100">
          PUT {Number.isFinite(safeStrike) ? `${safeStrike.toFixed(0)}` : "—"}
          {Number.isFinite(safeMid) ? ` @ ${safeMid.toFixed(2)}` : ""}
        </Badge>
      </div>
      {chartOptionsOpen && (
        <div className="mt-2 rounded-[6px] border border-[#1a3347] bg-[#050f1a] p-2.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 pb-2 sm:grid-cols-4">
            {[
              ["showSpot", "Spot"],
              ["showSelectedStrike", "Strike sél."],
              ["showSafeStrike", "Strike safe"],
              ["showExpectedMove", "Expected Move"],
              ["showClassicSupports", "Supports"],
              ["showClassicResistances", "Résistances"],
              ["showV4Zones", "Zones V4"],
              ["showWideSupport", "S. large"],
            ].map(([key, label]) => (
              <label key={key} className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-300 hover:text-slate-100">
                <input
                  type="checkbox"
                  checked={chartOptions[key]}
                  onChange={() => setChartOptions((prev) => ({ ...prev, [key]: !prev[key] }))}
                  className="h-3 w-3 cursor-pointer accent-sky-500"
                />
                {label}
              </label>
            ))}
          </div>
          <div className="flex flex-col gap-1.5 border-t border-[#1a3347] pt-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="w-[88px] text-[11px] text-slate-500">Style lignes</span>
              <div className="flex gap-1">
                {[["dashed", "Pointillé"], ["solid", "Plein"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, lineStyle: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.lineStyle === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
              <span className="w-[88px] text-[11px] text-slate-500">Épaisseur</span>
              <div className="flex gap-1">
                {[["fine", "Fine"], ["normal", "Normale"], ["thick", "Épaisse"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, lineWidth: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.lineWidth === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="w-[88px] text-[11px] text-slate-500">Courbe prix</span>
              <div className="flex gap-1">
                {[["standard", "Standard"], ["visible", "Visible"], ["muted", "Atténuée"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, priceLineStyle: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.priceLineStyle === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
              <span className="w-[88px] text-[11px] text-slate-500">Labels</span>
              <div className="flex gap-1">
                {[["normal", "Normaux"], ["compact", "Compacts"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, labelDensity: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.labelDensity === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="w-[88px] text-[11px] text-slate-500">Palette</span>
              <div className="flex gap-1">
                {[["standard", "Standard"], ["defensive", "Défensive"], ["contrast", "Contraste"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, palette: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.palette === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-[#1a3347] pt-1.5">
              <span className="w-[88px] text-[11px] text-slate-500">Période</span>
              <div className="flex gap-1">
                {[[60, "60j"], [120, "120j"], [180, "180j"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, periodDays: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.periodDays === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
              <span className="w-[88px] text-[11px] text-slate-500">Échelle</span>
              <div className="flex gap-1">
                {[["auto", "Auto"], ["tradeFocus", "Trade focus"], ["full", "Complet"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, scaleMode: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.scaleMode === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <span className="w-[88px] text-[11px] text-slate-500">Mode prix</span>
              <div className="flex gap-1">
                {[["linear", "Linéaire"], ["log", "Logarithmique"]].map(([val, lbl]) => (
                  <button key={val} type="button" onClick={() => setChartOptions((prev) => ({ ...prev, priceMode: val }))}
                    className={`rounded-[4px] border px-2 py-0.5 text-[11px] transition-colors ${chartOptions.priceMode === val ? "border-sky-600 bg-sky-900/40 text-sky-200" : "border-[#1a3347] bg-[#071420] text-slate-400 hover:border-[#2a5070] hover:text-slate-200"}`}
                  >{lbl}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-3 flex flex-1 flex-col rounded-[7px] border border-[#132536] bg-[#030b14] p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_26px_rgba(0,169,255,0.035)]">
        <div className="grid flex-1 grid-rows-[1fr] gap-3 xl:grid-cols-[minmax(0,1fr)_178px]">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full min-h-[420px] w-full" role="img" aria-label="Mini-graphe des niveaux de prix">
          <defs>
            <linearGradient id={`mini-chart-bg-${item.ticker}`} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#06131f" />
              <stop offset="100%" stopColor="#020811" />
            </linearGradient>
            <clipPath id={`mini-chart-clip-${item.ticker}`}>
              <rect x={padLeft} y={padTop} width={chartWidth} height={chartHeight} />
            </clipPath>
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
          {showV4Support && (
            <g>
              <rect
                x={padLeft}
                y={yForValue(Math.min(Number(v4SelectedSupport.zoneHigh), max))}
                width={chartWidth}
                height={Math.max(1, yForValue(Math.max(Number(v4SelectedSupport.zoneLow), min)) - yForValue(Math.min(Number(v4SelectedSupport.zoneHigh), max)))}
                fill={pal.supportV4}
                fillOpacity="0.10"
              />
              <text
                x={padLeft + 4}
                y={yForValue(Math.min(Number(v4SelectedSupport.zoneHigh), max)) + 11}
                fill={pal.supportV4}
                fontSize="10"
                opacity="0.70"
              >
                Support V4
              </text>
            </g>
          )}
          {showV4Resistance && (
            <g>
              <rect
                x={padLeft}
                y={yForValue(Math.min(Number(v4Resistance.zoneHigh), max))}
                width={chartWidth}
                height={Math.max(1, yForValue(Math.max(Number(v4Resistance.zoneLow), min)) - yForValue(Math.min(Number(v4Resistance.zoneHigh), max)))}
                fill={pal.resistanceV4}
                fillOpacity="0.10"
              />
              <text
                x={padLeft + 4}
                y={yForValue(Math.min(Number(v4Resistance.zoneHigh), max)) + 11}
                fill={pal.resistanceV4}
                fontSize="10"
                opacity="0.70"
              >
                Résistance V4
              </text>
            </g>
          )}
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
                {formatTick(tick)}
              </text>
            </g>
          ))}
          {filteredLevelRows.map((row) => {
            const y = yForValue(row.value);
            return (
              <g key={row.label}>
                <line x1={padLeft} x2={width - padRight} y1={y} y2={y} stroke={row.color} strokeDasharray={levelStrokeDasharray} strokeWidth={levelStrokeWidth} opacity="0.92" />
              </g>
            );
          })}
          {showV4Strike && (
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={yForValue(v4Strike)}
              y2={yForValue(v4Strike)}
              stroke={pal.selectedStrike}
              strokeDasharray={v4StrokeDasharray}
              strokeWidth={levelStrokeWidth}
              opacity="0.88"
            />
          )}
          {hasSeries ? (
            <polyline fill="none" stroke={pal.priceLine} strokeWidth={priceStrokeWidth} opacity={priceOpacity} strokeLinecap="round" strokeLinejoin="round" points={points} clipPath={`url(#mini-chart-clip-${item.ticker})`} />
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
        <div className={`hidden min-w-[168px] flex-col justify-center border-l border-[#132536] pl-4 xl:flex ${legendGapClass} ${legendTextClass}`}>
          {filteredLevelRows.map((row) => (
            <div key={`legend-${row.label}`} className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-semibold" style={{ color: row.color }}>
                <span className="h-2 w-2 rounded-full shadow-[0_0_10px_currentColor]" style={{ backgroundColor: row.color, color: row.color }} />
                {row.label}
              </span>
              <span className="font-semibold tabular-nums" style={{ color: row.color }}>${Number(row.value).toFixed(2)}</span>
            </div>
          ))}
          {showV4Support && (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-semibold" style={{ color: pal.supportV4 }}>
                <span className="block h-2 w-2 rounded-sm opacity-60" style={{ backgroundColor: pal.supportV4 }} />
                Support V4
              </span>
              <span className="font-semibold tabular-nums" style={{ color: pal.supportV4 }}>${Number(v4SelectedSupport.zoneLow).toFixed(0)}–{Number(v4SelectedSupport.zoneHigh).toFixed(0)}</span>
            </div>
          )}
          {showV4Resistance && (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-semibold" style={{ color: pal.resistanceV4 }}>
                <span className="block h-2 w-2 rounded-sm opacity-60" style={{ backgroundColor: pal.resistanceV4 }} />
                Résistance V4
              </span>
              <span className="font-semibold tabular-nums" style={{ color: pal.resistanceV4 }}>${Number(v4Resistance.zoneLow).toFixed(0)}–{Number(v4Resistance.zoneHigh).toFixed(0)}</span>
            </div>
          )}
          {showV4Strike && (
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 font-semibold" style={{ color: pal.selectedStrike }}>
                <span className="block h-2 w-2 rounded-sm opacity-60" style={{ backgroundColor: pal.selectedStrike }} />
                Strike sél.
              </span>
              <span className="font-semibold tabular-nums" style={{ color: pal.selectedStrike }}>${v4Strike.toFixed(2)}</span>
            </div>
          )}
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
        {filteredLevelRows.map((row) => (
          <div key={row.label} className="rounded-[6px] border border-[#132536] bg-[#06111b]/80 px-2 py-1.5">
            <span className="font-semibold" style={{ color: row.color }}>{row.label}</span>
            <span className="ml-1 text-slate-300">${Number(row.value).toFixed(2)}</span>
          </div>
        ))}
        {showV4Support && (
          <div className="rounded-[6px] border border-[#132536] bg-[#06111b]/80 px-2 py-1.5">
            <span className="font-semibold" style={{ color: pal.supportV4 }}>Support V4</span>
            <span className="ml-1 text-slate-300">${Number(v4SelectedSupport.zoneLow).toFixed(0)}–{Number(v4SelectedSupport.zoneHigh).toFixed(0)}</span>
          </div>
        )}
        {showV4Resistance && (
          <div className="rounded-[6px] border border-[#132536] bg-[#06111b]/80 px-2 py-1.5">
            <span className="font-semibold" style={{ color: pal.resistanceV4 }}>Résistance V4</span>
            <span className="ml-1 text-slate-300">${Number(v4Resistance.zoneLow).toFixed(0)}–{Number(v4Resistance.zoneHigh).toFixed(0)}</span>
          </div>
        )}
        {showV4Strike && (
          <div className="rounded-[6px] border border-[#132536] bg-[#06111b]/80 px-2 py-1.5">
            <span className="font-semibold" style={{ color: pal.selectedStrike }}>Strike sél.</span>
            <span className="ml-1 text-slate-300">${v4Strike.toFixed(2)}</span>
          </div>
        )}
      </div>

      <SupportResistanceV4InlineLine
        data={item.supportResistanceV4}
        className="mt-2"
      />
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
  const premiumUsedIsFinite = Number.isFinite(Number(premiumUsed));
  const displayedPremium = premiumUsedIsFinite
    ? Number(premiumUsed)
    : Number.isFinite(Number(mid))
    ? Number(mid)
    : null;
  // Quand on tombe sur le fallback mid, le label reflète la source réelle
  const resolvedPremiumLabel = premiumUsedIsFinite
    ? (premiumLabel || "Prime utilisée")
    : displayedPremium != null
    ? "Mid"
    : (premiumLabel || "Prime utilisée");
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
    : "border-slate-700";
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
    <div className={cn("rounded-2xl border bg-slate-900 p-4 shadow-sm", selectedBorder, className)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-100">{title}</p>
          <p className="mt-1 text-xs text-slate-500">{subtitle}</p>
        </div>
        <div className="flex flex-col items-end gap-2">
          {isSelected && (
            <Badge className={cn(
              "rounded-full text-xs",
              selectedGrade === "WATCH"
                ? "border border-amber-700 bg-amber-950/40 text-amber-300"
                : "border border-emerald-300 bg-emerald-950/40 text-emerald-300"
            )}>
              Sélectionné{selectedGrade ? ` [${selectedGrade}]` : ""}
            </Badge>
          )}
          <Badge className="rounded-full border border-indigo-800 bg-indigo-950/40 text-indigo-700">
            {label}
          </Badge>
          <Badge
            className={cn(
              "rounded-full",
              objectiveResolved
                ? "border border-emerald-800 bg-emerald-950/40 text-emerald-400"
                : "border border-rose-800 bg-rose-950/40 text-rose-400"
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
          label={resolvedPremiumLabel}
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

      <div className="mt-4 rounded-xl border border-slate-700 bg-slate-800/50 px-3 py-2 text-[11px] leading-5 text-slate-400">
        <span className="font-semibold text-slate-300">Diag reco</span>
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
    <div className="rounded-2xl border border-slate-700 bg-gradient-to-br from-slate-50 to-white p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <p className="text-sm font-semibold text-slate-100">Opportunités sous la borne basse attendue</p>
          <p className="mt-1 text-sm text-slate-400">
            Spot actuel <span className="font-medium text-slate-100">${item.price.toFixed(2)}</span> · borne basse attendue{" "}
            <span className="font-medium text-rose-400">${item.expectedMoveLow.toFixed(2)}</span> · borne haute attendue{" "}
            <span className="font-medium text-emerald-400">${item.expectedMoveHigh.toFixed(2)}</span>
          </p>
          <p className="mt-2 text-sm text-slate-400">
            Prime minimale cible safe :{" "}
            <span className="font-semibold text-slate-100">${Number(item.minPremium || 0).toFixed(2)}</span>
            {" "}· semaines cible :{" "}
            <span className="font-semibold text-slate-100">{item.targetWeeks ?? 1}</span>
          </p>
          {item.earningsMode && (
            <p className="mt-2 text-sm text-violet-400">
              Mode earnings actif : mouvement attendu normal{" "}
              <span className="font-semibold">{item.expectedMovePct.toFixed(2)}%</span> ×{" "}
              {item.expectedMoveMultiplier || 2} ={" "}
              <span className="font-semibold">{adjustedMovePct.toFixed(2)}%</span>.
            </p>
          )}
        </div>

        <Badge className="rounded-full border border-slate-600 bg-slate-900 text-slate-300">
          objectif 0.5% / semaine sur spot
        </Badge>
      </div>

      {safeEqualsAggressive && (
        <div className="mt-3 rounded-xl border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm font-semibold text-amber-300">
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
        <div className="mt-4 rounded-2xl border border-dashed border-slate-600 bg-slate-900 p-4 text-sm text-slate-500">
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


function ScanCompactBadge({ label, value, tone = "default" }) {
  const toneClasses =
    tone === "on"
      ? "border-emerald-700/60 bg-emerald-900/40 text-emerald-100"
      : tone === "off"
      ? "border-slate-700 bg-slate-800/70 text-slate-400"
      : "border-slate-700 bg-slate-800/70 text-slate-300";
  return (
    <span className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs ${toneClasses}`}>
      <span className="text-slate-500">{label}</span>
      <span className="font-medium text-slate-100">{value ?? "—"}</span>
    </span>
  );
}

// Patch 3A — chips éditables de la barre de scan (UI uniquement, states/handlers existants).
function EditableScanInput({ label, value, onChange, type = "number", min, max, step, title, suffix, list, wrapperClassName = "", inputClassName = "w-full min-w-0 flex-1" }) {
  return (
    <label
      title={title}
      className={`inline-flex min-w-0 items-center gap-0.5 overflow-hidden rounded-lg border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-300 focus-within:border-sky-600 ${wrapperClassName}`}
    >
      <span className="shrink-0 text-slate-500">{label}</span>
      <input
        type={type}
        value={value}
        min={min}
        max={max}
        step={step}
        list={list}
        onChange={onChange}
        className={`${inputClassName} bg-transparent font-medium text-slate-100 outline-none`}
      />
      {suffix ? <span className="shrink-0 text-slate-500">{suffix}</span> : null}
    </label>
  );
}

function EditableScanSelect({ label, value, onChange, children, title, wrapperClassName = "" }) {
  return (
    <label
      title={title}
      className={`inline-flex min-w-0 items-center gap-0.5 overflow-hidden rounded-lg border border-slate-700 bg-slate-800/70 px-1.5 py-1 text-xs text-slate-300 focus-within:border-sky-600 ${wrapperClassName}`}
    >
      <span className="shrink-0 text-slate-500">{label}</span>
      <select
        value={value}
        onChange={onChange}
        className="w-full min-w-0 flex-1 bg-transparent font-medium text-slate-100 outline-none [&>option]:bg-slate-900"
      >
        {children}
      </select>
    </label>
  );
}

function LockedScanBadge({ label, value, title, wrapperClassName = "" }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-0.5 rounded-lg border border-emerald-800 bg-emerald-950/40 px-1.5 py-1 text-xs text-emerald-200 ${wrapperClassName}`}
    >
      <span className="text-emerald-400">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
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

function formatSupportResistanceV4Price(value) {
  return Number.isFinite(Number(value)) ? `$${Number(value).toFixed(2)}` : "n/a";
}

function formatSupportResistanceV4Pct(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(2)} %` : "n/a";
}

function formatSupportResistanceV4Number(value) {
  return Number.isFinite(Number(value)) ? String(Number(value)) : "n/a";
}

function formatSupportResistanceV4Zone(zone) {
  if (!zone || typeof zone !== "object") return "n/a";
  const low = formatSupportResistanceV4Price(zone.zoneLow);
  const high = formatSupportResistanceV4Price(zone.zoneHigh);
  if (low === "n/a" && high === "n/a") return "n/a";
  return `${low} - ${high}`;
}

function supportResistanceV4ConfidenceLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized;
  return "n/a";
}

function supportResistanceV4ProtectionStatusLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  switch (normalized) {
    case "protected":
    case "partially_protected":
    case "weakly_protected":
    case "unprotected":
    case "unavailable":
      return normalized;
    default:
      return "n/a";
  }
}

function supportResistanceV4RoleLabel(value) {
  const normalized = String(value || "").trim().toLowerCase();
  switch (normalized) {
    case "support":
    case "resistance":
    case "broken_resistance_support":
    case "broken_support_resistance":
      return normalized;
    default:
      return "n/a";
  }
}

function SupportResistanceV4ZoneCard({ title, zone, emptyLabel }) {
  if (!zone || typeof zone !== "object") {
    return (
      <div className="rounded-[6px] border border-slate-700/70 bg-slate-950/70 px-3 py-2 text-xs text-slate-400">
        <p className="font-semibold uppercase tracking-wide text-slate-300">{title}</p>
        <p className="mt-2">{emptyLabel}</p>
      </div>
    );
  }

  const notes = Array.isArray(zone.notes) ? zone.notes.filter(Boolean) : [];

  return (
    <div className="rounded-[6px] border border-slate-700/70 bg-slate-950/70 px-3 py-2 text-xs text-slate-200">
      <p className="font-semibold uppercase tracking-wide text-slate-200">{title}</p>
      <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Zone</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Zone(zone)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Milieu</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Price(zone.zoneMid)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Clotures</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Number(zone.closeTouchCount)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Meches</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Number(zone.wickTouchCount)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Distance spot</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Pct(zone.distanceToSpotPct)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Distance strike</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Pct(zone.distanceToStrikePct)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Score</p>
          <p className="mt-1 font-medium text-slate-100">
            {Number.isFinite(Number(zone.score)) ? `${Number(zone.score)} / 100` : "n/a"}
          </p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Confiance</p>
          <p className="mt-1 font-medium text-slate-100">{supportResistanceV4ConfidenceLabel(zone.confidence)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Role</p>
          <p className="mt-1 font-medium text-slate-100">{supportResistanceV4RoleLabel(zone.role)}</p>
        </div>
        <div>
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Derniere touche</p>
          <p className="mt-1 font-medium text-slate-100">
            {Number.isFinite(Number(zone.lastTouchDaysAgo)) ? `${Number(zone.lastTouchDaysAgo)} j` : "n/a"}
          </p>
        </div>
      </div>
      <div className="mt-2">
        <p className="text-[11px] uppercase tracking-wide text-slate-500">Notes</p>
        <p className="mt-1 text-slate-300">{notes.length ? notes.join(" · ") : "n/a"}</p>
      </div>
    </div>
  );
}

function SupportResistanceV4MiniList({ title, zones, emptyLabel }) {
  const rows = Array.isArray(zones) ? zones.slice(0, 3) : [];

  return (
    <div className="rounded-[6px] border border-slate-700/70 bg-slate-950/60 px-3 py-2 text-xs text-slate-200">
      <p className="font-semibold uppercase tracking-wide text-slate-300">{title}</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-slate-400">{emptyLabel}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {rows.map((zone, index) => (
            <div key={`${title}-${index}-${zone?.zoneMid ?? "na"}`} className="rounded-[5px] border border-slate-800 bg-slate-950/80 px-2 py-1.5">
              <p className="font-medium text-slate-100">
                #{index + 1} · {formatSupportResistanceV4Zone(zone)}
              </p>
              <p className="mt-1 text-slate-400">
                score {Number.isFinite(Number(zone?.score)) ? Number(zone.score) : "n/a"} / 100 ·
                clotures {formatSupportResistanceV4Number(zone?.closeTouchCount)} ·
                meches {formatSupportResistanceV4Number(zone?.wickTouchCount)} ·
                spot {formatSupportResistanceV4Pct(zone?.distanceToSpotPct)} ·
                strike {formatSupportResistanceV4Pct(zone?.distanceToStrikePct)} ·
                {` ${supportResistanceV4RoleLabel(zone?.role)}`}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SupportResistanceV4Panel({ data }) {
  if (!data || typeof data !== "object") {
    return (
      <div className="rounded-[7px] border border-slate-700/70 bg-slate-950/70 px-3 py-3 text-sm text-slate-400">
        V4 non disponible pour ce candidat.
      </div>
    );
  }

  const supports = Array.isArray(data.supports) ? data.supports : [];
  const resistances = Array.isArray(data.resistances) ? data.resistances : [];
  const strikeProtection = data.strikeProtectionV4 && typeof data.strikeProtectionV4 === "object"
    ? data.strikeProtectionV4
    : null;
  const strikeProtectionZone = strikeProtection?.selectedSupportZone
    ? formatSupportResistanceV4Zone(strikeProtection.selectedSupportZone)
    : "n/a";

  return (
    <div className="rounded-[7px] border border-slate-700/70 bg-slate-950/70 px-3 py-3 text-sm text-slate-200">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className="rounded-[4px] border border-slate-600 bg-slate-900/90 px-2 py-0.5 text-[11px] text-slate-200">
          Diagnostic seulement
        </Badge>
        <Badge className="rounded-[4px] border border-slate-700 bg-slate-950/90 px-2 py-0.5 text-[11px] text-slate-300">
          min. 3 clotures
        </Badge>
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-300">
        {data.summaryFr || "V4 non disponible pour ce candidat."}
      </p>
      <div className="mt-3 rounded-[6px] border border-slate-800 bg-slate-950/80 px-2.5 py-2 text-xs text-slate-300">
        <span className="font-semibold uppercase tracking-wide text-slate-400">Protection strike V4</span>
        <p className="mt-1">
          {supportResistanceV4ProtectionStatusLabel(strikeProtection?.status)} · score{" "}
          {Number.isFinite(Number(strikeProtection?.score)) ? `${Number(strikeProtection.score)} / 100` : "n/a"} —{" "}
          {strikeProtection?.summaryFr || "n/a"}
          {strikeProtection?.selectedSupportZone ? ` · zone ${strikeProtectionZone}` : ""}
        </p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        <div className="rounded-[6px] border border-slate-800 bg-slate-950/80 px-2.5 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Available</p>
          <p className="mt-1 font-medium text-slate-100">{data.available === true ? "true" : "false"}</p>
        </div>
        <div className="rounded-[6px] border border-slate-800 bg-slate-950/80 px-2.5 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Tolerance</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Price(data.tolerance)}</p>
        </div>
        <div className="rounded-[6px] border border-slate-800 bg-slate-950/80 px-2.5 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">ATR</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Price(data.atr)}</p>
        </div>
        <div className="rounded-[6px] border border-slate-800 bg-slate-950/80 px-2.5 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Zones</p>
          <p className="mt-1 font-medium text-slate-100">{formatSupportResistanceV4Number(data.zonesCount)}</p>
        </div>
        <div className="rounded-[6px] border border-slate-800 bg-slate-950/80 px-2.5 py-2">
          <p className="text-[11px] uppercase tracking-wide text-slate-500">Version</p>
          <p className="mt-1 font-medium text-slate-100">{data.version || "n/a"}</p>
        </div>
      </div>
      <div className="mt-3 grid gap-2 xl:grid-cols-2">
        <SupportResistanceV4ZoneCard
          title="Meilleur support confirme"
          zone={data.bestSupportZone}
          emptyLabel="Aucun support confirme par 3 clotures."
        />
        <SupportResistanceV4ZoneCard
          title="Meilleure resistance confirmee"
          zone={data.bestResistanceZone}
          emptyLabel="Aucune resistance confirmee par 3 clotures."
        />
      </div>
      <div className="mt-3 grid gap-2 xl:grid-cols-2">
        <SupportResistanceV4MiniList
          title="Top 3 supports"
          zones={supports}
          emptyLabel="Aucun support confirme par 3 clotures."
        />
        <SupportResistanceV4MiniList
          title="Top 3 resistances"
          zones={resistances}
          emptyLabel="Aucune resistance confirmee par 3 clotures."
        />
      </div>
    </div>
  );
}

function supportResistanceV4ProtectionStatusLabelFr(value) {
  const normalized = String(value || "").trim().toLowerCase();
  switch (normalized) {
    case "protected":
      return "protégé";
    case "partially_protected":
      return "partiellement protégé";
    case "weakly_protected":
      return "faiblement protégé";
    case "unprotected":
      return "non protégé";
    case "unavailable":
      return "indisponible";
    default:
      return "n/a";
  }
}

function formatSupportResistanceV4SignedPctCompact(value) {
  if (!Number.isFinite(Number(value))) return "n/a";
  const numericValue = Number(value);
  return `${numericValue > 0 ? "+" : ""}${numericValue.toFixed(2)} %`;
}

function formatSupportResistanceV4ScoreCompact(value) {
  return Number.isFinite(Number(value)) ? `${Number(value)} / 100` : "n/a";
}

function formatSupportResistanceV4CompactZoneLine(zone, distanceLabel, distanceValue) {
  if (!zone || typeof zone !== "object") return "n/a";
  const zoneLabel = formatSupportResistanceV4Zone(zone);
  const distanceLabelValue = formatSupportResistanceV4SignedPctCompact(distanceValue);
  if (zoneLabel === "n/a" && distanceLabelValue === "n/a") return "n/a";
  if (distanceLabelValue === "n/a") return zoneLabel;
  if (zoneLabel === "n/a") return `${distanceLabel} ${distanceLabelValue}`;
  return `${zoneLabel} · ${distanceLabel} ${distanceLabelValue}`;
}

function SupportResistanceV4CompactPanel({ data, variant = "dark", className = "" }) {
  const isLight = variant === "light";
  const strikeProtection =
    data?.strikeProtectionV4 && typeof data.strikeProtectionV4 === "object"
      ? data.strikeProtectionV4
      : null;
  const usefulSupportZone =
    strikeProtection?.selectedSupportZone && typeof strikeProtection.selectedSupportZone === "object"
      ? strikeProtection.selectedSupportZone
      : data?.bestSupportZone && typeof data.bestSupportZone === "object"
      ? data.bestSupportZone
      : null;
  const nearbyResistanceZone =
    data?.bestResistanceZone && typeof data.bestResistanceZone === "object"
      ? data.bestResistanceZone
      : null;
  const protectionLine = strikeProtection
    ? `Protection strike : ${supportResistanceV4ProtectionStatusLabelFr(strikeProtection.status)} · score ${formatSupportResistanceV4ScoreCompact(strikeProtection.score)}`
    : "Protection strike : n/a";
  const summaryLine = strikeProtection?.summaryFr || data?.summaryFr || "n/a";
  const usefulSupportLine = formatSupportResistanceV4CompactZoneLine(
    usefulSupportZone,
    "distance strike",
    usefulSupportZone?.distanceToStrikePct
  );
  const nearbyResistanceLine = formatSupportResistanceV4CompactZoneLine(
    nearbyResistanceZone,
    "distance spot",
    nearbyResistanceZone?.distanceToSpotPct
  );

  return (
    <div
      className={cn(
        isLight
          ? "rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-200"
          : "rounded-[7px] border border-[#172637] bg-[#06101a]/95 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_20px_rgba(0,170,255,0.025)]",
        className
      )}
    >
      <p className={isLight ? "text-xs font-semibold uppercase tracking-wide text-slate-500" : "text-xs font-semibold uppercase tracking-wide text-slate-400"}>
        Support/RÃ©sistance V4 â€” diagnostic
      </p>
      <div className={isLight ? "mt-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-3" : "mt-2 rounded-[6px] border border-[#132536] bg-[#020811]/70 px-3 py-3"}>
        {!data || typeof data !== "object" ? (
          <p className={isLight ? "text-sm font-semibold text-slate-100" : "text-sm font-semibold text-slate-100"}>
            V4 : indisponible
          </p>
        ) : (
          <>
            <p className={isLight ? "text-sm font-semibold text-slate-100" : "text-sm font-semibold text-slate-100"}>
              {protectionLine}
            </p>
            <p className={isLight ? "mt-1 leading-5 text-slate-400" : "mt-1 leading-5 text-slate-300"}>
              RÃ©sumÃ© : {summaryLine}
            </p>
            <p className={isLight ? "mt-1 leading-5 text-slate-400" : "mt-1 leading-5 text-slate-300"}>
              Support utile : {usefulSupportLine}
            </p>
            <p className={isLight ? "mt-1 leading-5 text-slate-400" : "mt-1 leading-5 text-slate-300"}>
              RÃ©sistance proche : {nearbyResistanceLine}
            </p>
          </>
        )}
      </div>
      {data && typeof data === "object" ? (
        <details className={isLight ? "mt-3 rounded-xl border border-slate-700 bg-slate-900 p-3" : "mt-3 rounded-[6px] border border-[#132536] bg-[#020811]/60 p-3"}>
          <summary className={isLight ? "flex cursor-pointer list-none items-center gap-3 text-sm font-semibold text-slate-100 after:ml-auto after:text-lg after:leading-none after:text-slate-500 after:content-['â€º'] [&::-webkit-details-marker]:hidden" : "flex cursor-pointer list-none items-center gap-3 text-sm font-semibold text-slate-100 after:ml-auto after:text-lg after:leading-none after:text-slate-400 after:content-['â€º'] [&::-webkit-details-marker]:hidden"}>
            Voir dÃ©tails V4
          </summary>
          <div className="mt-3">
            <SupportResistanceV4Panel data={data} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SupportResistanceV4CompactPanelClean({ data, variant = "dark", className = "" }) {
  const isLight = variant === "light";
  const strikeProtection =
    data?.strikeProtectionV4 && typeof data.strikeProtectionV4 === "object"
      ? data.strikeProtectionV4
      : null;
  const usefulSupportZone =
    strikeProtection?.selectedSupportZone && typeof strikeProtection.selectedSupportZone === "object"
      ? strikeProtection.selectedSupportZone
      : data?.bestSupportZone && typeof data.bestSupportZone === "object"
      ? data.bestSupportZone
      : null;
  const nearbyResistanceZone =
    data?.bestResistanceZone && typeof data.bestResistanceZone === "object"
      ? data.bestResistanceZone
      : null;
  const protectionLine = strikeProtection
    ? `Protection strike : ${supportResistanceV4ProtectionStatusLabelFr(strikeProtection.status)} · score ${formatSupportResistanceV4ScoreCompact(strikeProtection.score)}`
    : "Protection strike : n/a";
  const summaryLine = strikeProtection?.summaryFr || data?.summaryFr || "n/a";
  const usefulSupportLine = formatSupportResistanceV4CompactZoneLine(
    usefulSupportZone,
    "distance strike",
    usefulSupportZone?.distanceToStrikePct
  );
  const nearbyResistanceLine = formatSupportResistanceV4CompactZoneLine(
    nearbyResistanceZone,
    "distance spot",
    nearbyResistanceZone?.distanceToSpotPct
  );

  return (
    <div
      className={cn(
        isLight
          ? "rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-200"
          : "rounded-[7px] border border-[#172637] bg-[#06101a]/95 px-4 py-3 text-sm text-slate-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.035),0_0_20px_rgba(0,170,255,0.025)]",
        className
      )}
    >
      <p className={isLight ? "text-xs font-semibold uppercase tracking-wide text-slate-500" : "text-xs font-semibold uppercase tracking-wide text-slate-400"}>
        Support/Résistance V4 — diagnostic
      </p>
      <div className={isLight ? "mt-2 rounded-xl border border-slate-700 bg-slate-900 px-3 py-3" : "mt-2 rounded-[6px] border border-[#132536] bg-[#020811]/70 px-3 py-3"}>
        {!data || typeof data !== "object" ? (
          <p className={isLight ? "text-sm font-semibold text-slate-100" : "text-sm font-semibold text-slate-100"}>
            V4 : indisponible
          </p>
        ) : (
          <>
            <p className={isLight ? "text-sm font-semibold text-slate-100" : "text-sm font-semibold text-slate-100"}>
              {protectionLine}
            </p>
            <p className={isLight ? "mt-1 leading-5 text-slate-400" : "mt-1 leading-5 text-slate-300"}>
              Résumé : {summaryLine}
            </p>
            <p className={isLight ? "mt-1 leading-5 text-slate-400" : "mt-1 leading-5 text-slate-300"}>
              Support utile : {usefulSupportLine}
            </p>
            <p className={isLight ? "mt-1 leading-5 text-slate-400" : "mt-1 leading-5 text-slate-300"}>
              Résistance proche : {nearbyResistanceLine}
            </p>
          </>
        )}
      </div>
      {data && typeof data === "object" ? (
        <details className={isLight ? "mt-3 rounded-xl border border-slate-700 bg-slate-900 p-3" : "mt-3 rounded-[6px] border border-[#132536] bg-[#020811]/60 p-3"}>
          <summary className={isLight ? "flex cursor-pointer list-none items-center gap-3 text-sm font-semibold text-slate-100 after:ml-auto after:text-lg after:leading-none after:text-slate-500 after:content-['>'] [&::-webkit-details-marker]:hidden" : "flex cursor-pointer list-none items-center gap-3 text-sm font-semibold text-slate-100 after:ml-auto after:text-lg after:leading-none after:text-slate-400 after:content-['>'] [&::-webkit-details-marker]:hidden"}>
            Voir détails V4
          </summary>
          <div className="mt-3">
            <SupportResistanceV4Panel data={data} />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function SupportResistanceV4InlineLine({ data, className = "" }) {
  const strikeProtection =
    data?.strikeProtectionV4 && typeof data.strikeProtectionV4 === "object"
      ? data.strikeProtectionV4
      : null;
  const usefulSupportZone =
    strikeProtection?.selectedSupportZone && typeof strikeProtection.selectedSupportZone === "object"
      ? strikeProtection.selectedSupportZone
      : data?.bestSupportZone && typeof data.bestSupportZone === "object"
      ? data.bestSupportZone
      : null;

  if (!data || typeof data !== "object") return null;

  const statusLabel = strikeProtection
    ? supportResistanceV4ProtectionStatusLabelFr(strikeProtection.status)
    : null;
  const supportLabel = usefulSupportZone ? formatSupportResistanceV4Zone(usefulSupportZone) : null;

  return (
    <details className={cn("rounded-[5px] border border-[#132536] bg-[#06101a]/60 px-3 py-1.5", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-slate-400 [&::-webkit-details-marker]:hidden">
        <span className="font-semibold text-slate-300">V4</span>
        {statusLabel && (
          <>
            <span className="text-slate-400">·</span>
            <span>{statusLabel}</span>
          </>
        )}
        {supportLabel && (
          <>
            <span className="text-slate-400">·</span>
            <span>support {supportLabel}</span>
          </>
        )}
        <span className="ml-auto text-slate-500">détails ›</span>
      </summary>
      <div className="mt-2">
        <SupportResistanceV4Panel data={data} />
      </div>
    </details>
  );
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
    <div className="rounded-xl border border-slate-700 bg-slate-800/80 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
      <p className="mt-1 text-sm font-semibold text-slate-100">
        Strike {formatStrikeOrDash(strike?.strike)}
      </p>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        Bid {formatMoneyOrDash(strike?.bid)} / Ask {formatMoneyOrDash(strike?.ask)} / Mid{" "}
        {formatMoneyOrDash(strike?.mid)}
      </p>
      <p className="text-xs leading-5 text-slate-400">
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
    ? "border-slate-700"
    : selectedGrade === "WATCH"
    ? "border-amber-500 ring-2 ring-amber-300/55 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]"
    : "border-emerald-500 ring-2 ring-emerald-300/55 shadow-[0_0_0_1px_rgba(16,185,129,0.15)]";
  const selectedBadgeClass = selectedGrade === "WATCH"
    ? "border border-amber-700 bg-amber-950/40 text-amber-300"
    : "border border-emerald-300 bg-emerald-950/40 text-emerald-300";
  return (
    <div className={cn("rounded-xl border bg-slate-800/80 p-3", selectedBorder)}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</p>
          <p className="mt-1 text-sm font-semibold text-slate-100">
            Strike {formatStrikeOrDash(strike?.strike)}
          </p>
        </div>
        {isSelected && (
          <Badge className={cn("rounded-full px-2 py-0.5 text-[11px]", selectedBadgeClass)}>
            Sélectionné{selectedGrade ? ` [${selectedGrade}]` : ""}
          </Badge>
        )}
      </div>
      <p className="mt-2 text-xs leading-5 text-slate-400">
        Bid {formatMoneyOrDash(strike?.bid)} / Ask {formatMoneyOrDash(strike?.ask)} / Mid{" "}
        {formatMoneyOrDash(strike?.mid)}
      </p>
      <p className="text-xs leading-5 text-slate-400">
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

  const yieldDecimal = Number(strike.premiumYield ?? strike.premiumYieldOnUnderlying);
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

function buildIbkrDataProvenance({ ibkrCandidate, spot }) {
  const requested = ibkrCandidate?.marketDataTypeRequested ?? null;
  const requestedLabel = ibkrCandidate?.marketDataTypeRequestedLabel ?? "unknown";
  const receivedLabel = ibkrCandidate?.marketDataTypeReceivedLabel ?? "unknown";
  const hasIbkrSpot =
    Number.isFinite(Number(ibkrCandidate?.currentPrice)) ||
    Number.isFinite(Number(ibkrCandidate?.underlyingPrice));
  return {
    sourceSpot: hasIbkrSpot ? "ibkr" : Number.isFinite(Number(spot)) && spot > 0 ? "yahoo" : "unknown",
    sourceOptions: "ibkr",
    ibkrMarketDataTypeRequested: requested,
    ibkrMarketDataTypeRequestedLabel: requestedLabel,
    ibkrMarketDataTypeReceivedLabel: receivedLabel,
    scanCompletedAt: ibkrCandidate?.scanCompletedAt ?? null,
  };
}

function formatIbkrOptionsProvenanceLabel(provenance) {
  if (!provenance) return "Options : IBKR (provenance inconnue)";
  const received = String(provenance.ibkrMarketDataTypeReceivedLabel || "unknown");
  const requested = String(provenance.ibkrMarketDataTypeRequestedLabel || "unknown");
  if (received === "live") return "Options : IBKR live";
  if (requested === "live") return "Options : IBKR live demandé";
  if (received === "frozen" || requested === "frozen") return "Options : IBKR frozen";
  if (received === "delayed" || requested === "delayed") return "Options : IBKR delayed";
  if (received === "delayed_frozen" || requested === "delayed_frozen")
    return "Options : IBKR delayed_frozen";
  return "Options : IBKR (type inconnu)";
}

function formatIbkrSpotProvenanceLine(provenance) {
  if (!provenance) return "";
  const sourceSpot = provenance.sourceSpot;
  const requested = String(provenance.ibkrMarketDataTypeRequestedLabel || "unknown");
  const received = String(provenance.ibkrMarketDataTypeReceivedLabel || "unknown");
  const spotLabel =
    sourceSpot === "ibkr"
      ? received === "live"
        ? "IBKR live"
        : requested === "live"
        ? "IBKR live demandé"
        : `IBKR ${received !== "unknown" ? received : requested}`
      : sourceSpot === "yahoo"
      ? "Yahoo"
      : "indisponible";
  const optionsLabel =
    received === "live"
      ? "IBKR live"
      : requested === "live"
      ? "IBKR live demandé"
      : `IBKR ${received !== "unknown" ? received : requested}`;
  return `Spot : ${spotLabel} · Options : ${optionsLabel}`;
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
  if (DEBUG_DTE_RESOLVE) console.log("[DTE_RESOLVE]", {
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
  const selectedLeg =
    finalDisplayRecommendation.finalDisplayMode === "AGGRESSIVE"
      ? aggressiveStrikeWithPop
      : safeStrikeWithPop;
  const mergedSupportResistanceV4 = (() => {
    const fallback =
      yahooCandidate?.supportResistanceV4 && typeof yahooCandidate.supportResistanceV4 === "object"
        ? { ...yahooCandidate.supportResistanceV4 }
        : yahooCandidate?.raw?.supportResistanceV4 &&
            typeof yahooCandidate.raw.supportResistanceV4 === "object"
          ? { ...yahooCandidate.raw.supportResistanceV4 }
          : null;
    const selectedStrike = Number(selectedLeg?.strike);
    const ohlcCandles = yahooCandidate?.raw?.ohlcCandles ?? null;
    if (!Number.isFinite(selectedStrike) || selectedStrike <= 0) return fallback;
    if (!Array.isArray(ohlcCandles) || ohlcCandles.length === 0) return fallback;
    if (!Number.isFinite(Number(spot)) || Number(spot) <= 0) return fallback;
    return buildSupportResistanceV4ConfirmedZones({
      ohlcCandles,
      spot: Number(spot),
      strike: selectedStrike,
      dteDays: Number.isFinite(Number(resolvedDteDays)) ? Number(resolvedDteDays) : null,
    });
  })();
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
    minPremium: ibkrCandidate?.targetPremium ?? yahooCandidate?.minPremium ?? minPremiumForSpot(spot, resolvedDteDays),
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
    supportStatusLegacy:
      yahooCandidate?.supportStatusLegacy ??
      yahooCandidate?.supportResistance?.supportStatus ??
      null,
    supportStatusV2: yahooCandidate?.supportStatusV2 ?? null,
    supportScoringV2:
      yahooCandidate?.supportScoringV2 && typeof yahooCandidate.supportScoringV2 === "object"
        ? { ...yahooCandidate.supportScoringV2 }
        : yahooCandidate?.raw?.supportScoringV2 &&
            typeof yahooCandidate.raw.supportScoringV2 === "object"
          ? { ...yahooCandidate.raw.supportScoringV2 }
          : null,
    supportStatusUsedByQualityScore: yahooCandidate?.supportStatusUsedByQualityScore ?? null,
    strikeVsSupportEffectivePct: yahooCandidate?.strikeVsSupportEffectivePct ?? null,
    qualityScoreDeltaLegacyVsV2: yahooCandidate?.qualityScoreDeltaLegacyVsV2 ?? null,
    supportDiagnosticsV1:
      yahooCandidate?.supportDiagnosticsV1 && typeof yahooCandidate.supportDiagnosticsV1 === "object"
        ? { ...yahooCandidate.supportDiagnosticsV1 }
        : yahooCandidate?.raw?.supportDiagnosticsV1 &&
            typeof yahooCandidate.raw.supportDiagnosticsV1 === "object"
          ? { ...yahooCandidate.raw.supportDiagnosticsV1 }
          : null,
    supportResistanceV4: mergedSupportResistanceV4,
    macd: yahooCandidate?.macd ?? "—",
    zone: "sous borne basse IBKR",
    verdict: yahooCandidate?.verdict ?? "conservative",
    ok: yahooCandidate?.ok ?? true,
    note: yahooCandidate?.note ?? "Candidat IBKR live ajouté sans contexte technique Yahoo.",
    techniqueSource: yahooCandidate ? "Yahoo" : "—",
    optionsSource: "IBKR live",
    dataProvenance: buildIbkrDataProvenance({ ibkrCandidate, spot }),
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
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className="rounded-full border border-slate-600 bg-slate-800/50 text-slate-300">
              {item.symbol}
            </Badge>
            <Badge className="rounded-full border border-sky-200 bg-sky-50 text-sky-700">
              Technique : {techniqueBadgeLabel(item)}
            </Badge>
            <Badge className="rounded-full border border-emerald-800 bg-emerald-950/40 text-emerald-400">
              Options : {item.optionsSource}
            </Badge>
            {Number.isFinite(Number(item.eliteScore)) && (
              <Badge className={cn("rounded-full border", classifyEliteBadge(item.eliteBadge))}>
                Elite {Number(item.eliteScore).toFixed(1)} · {item.eliteBadge || "Speculative"}
              </Badge>
            )}
          </div>

          <div>
            <h3 className="text-xl font-semibold tracking-tight text-slate-100">{item.symbol}</h3>
            <p className="mt-1 text-sm text-slate-400">
              Yahoo pour le contexte technique (si disponible) · IBKR pour les options live.
            </p>
            {earningsDisplay ? (
              <p className="mt-1 text-sm text-amber-400">{earningsDisplay}</p>
            ) : item.earningsDate || item.nextEarningsDate ? (
              <p className="mt-1 text-sm text-violet-400">
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
            <div className="rounded-xl border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm text-slate-300">
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
                  ? "border-rose-800 bg-rose-950/40 text-rose-400"
                  : "border-amber-800 bg-amber-950/40 text-amber-300"
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
    <Card className="mb-6 rounded-[28px] border-slate-700 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-xl text-slate-100">
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
          <div className="rounded-2xl border border-dashed border-slate-600 bg-slate-800/50 p-8 text-center text-sm text-slate-500">
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
            <p className="rounded-xl border border-amber-700 bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-300">
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

function CandidateCard({ item, displayRank, yahooRankForIbkr, onOpenDetail, ibkrBatchRow = null, seasonality = null, highlightedTicker = null, isExpanded = false, onToggleExpand = null }) {
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
  // Capital / contrat doit refléter la jambe réellement sélectionnée (SAFE ou AGRESSIF),
  // pas systématiquement primaryStrike (= SAFE). On réutilise displayLeg ci-dessus.
  // Fallback legacy vers item.capitalPerContract si le strike de la jambe est absent.
  const displayCapitalPerContract =
    Number.isFinite(Number(displayLeg?.strike)) && Number(displayLeg.strike) > 0
      ? Number(displayLeg.strike) * 100
      : item.capitalPerContract;
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
                    {tickerMeta.type && tickerMeta.sector && <span className="mx-1 text-slate-400">·</span>}
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
                    <Badge className="rounded-[4px] border border-violet-200 bg-violet-50 px-2 py-0.5 text-xs text-violet-400">
                      mode earnings x{item.expectedMoveMultiplier || 2}
                    </Badge>
                  )}
                  {item.ok && !item.ibkrDevObjectiveBlocked ? (
                    <Badge className="rounded-[4px] border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-400">
                      objectif validé
                    </Badge>
                  ) : (
                    <Badge className="rounded-[4px] border border-slate-700 bg-slate-800/50 px-2 py-0.5 text-xs text-slate-400">
                      à surveiller
                    </Badge>
                  )}
                  {item.optionsSource === "IBKR live" && (
                    <Badge className="rounded-[4px] border border-sky-200 bg-sky-50 px-2 py-0.5 text-xs text-sky-700">
                      Technique : {techniqueBadgeLabel(item)}
                    </Badge>
                  )}
                  {item.optionsSource === "IBKR live" && (
                    <Badge className="rounded-[4px] border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-400">
                      {formatIbkrOptionsProvenanceLabel(item.dataProvenance)}
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
                {onToggleExpand && (
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    title={isExpanded ? "Réduire la carte" : "Afficher plus de détails"}
                    onClick={onToggleExpand}
                    className="shrink-0 rounded-[6px] border border-slate-700 bg-[#07111b] px-3 py-1 text-sm text-slate-300 hover:text-white hover:border-slate-500 transition-colors"
                  >
                    {isExpanded ? "Réduire ▲" : "Afficher plus ▼"}
                  </button>
                )}
                <Button
                  className="shrink-0 rounded-[6px] border border-slate-600 bg-[#07111b] px-3 py-1 text-sm text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
                  onClick={() => onOpenDetail(item)}
                >
                  Voir fiche complète ↗
                </Button>
              </div>

              {/* Ligne 2 : sous-titre setup */}
              <p className="text-xs text-slate-400 leading-tight">{item.setup}</p>

              {item.dataProvenance && (
                <p className="text-[11px] text-slate-500 leading-tight">
                  {formatIbkrSpotProvenanceLine(item.dataProvenance)}
                </p>
              )}

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
                    <Badge className="rounded-[4px] border border-amber-400 bg-amber-950/40 px-2 py-0.5 text-xs text-amber-950">
                      DEV TEST — données hors marché / non tradables
                    </Badge>
                  )}
                  {item.indicativeShortlistSession && !item.ibkrDirect?.devScanEnabled && (
                    <Badge className="rounded-[4px] border border-amber-400 bg-amber-950/40 px-2 py-0.5 text-xs text-amber-950">
                      DEV TEST — marche ferme / donnees indicatives / non tradables
                    </Badge>
                  )}
                  {item.ibkrDevIncompleteSurface && (
                    <Badge className="rounded-[4px] border border-amber-700 bg-amber-100 px-2 py-0.5 text-xs text-amber-950">
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
                <FaceplateMetric label="Capital / contrat" value={`$${displayCapitalPerContract.toFixed(0)}`} />
              </div>

              {isExpanded && (<>
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
                      <div className="rounded-xl border border-amber-400/30 bg-amber-950/400/10 px-3 py-2 font-semibold text-amber-300">
                        RSI élevé : surachat court terme
                      </div>
                    )}
                    <SupportStatusLine item={item} />
                    <IbkrBatchCardDetails item={item} row={ibkrBatchRow} />
                  </div>
                </details>
              </div>
              <details className="hidden">
                <summary className="flex cursor-pointer list-none items-center gap-3 font-semibold uppercase tracking-wide text-slate-100 after:ml-auto after:text-xl after:leading-none after:text-slate-100 after:content-['›'] [&::-webkit-details-marker]:hidden">
                  Support/Résistance V4 — zones confirmées
                </summary>
                <div className="mt-3">
                  <SupportResistanceV4Panel data={item.supportResistanceV4} />
                </div>
              </details>
              <div className="rounded-[6px] border border-[#132536] bg-[#06111b]/70 px-3 py-2 text-xs text-slate-400">
                Note : les niveaux techniques proviennent des 60 derniers jours (daily). Les prix et options sont en temps réel via IBKR.
              </div>
              </>)}
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

function buildAutoJournalStrikePayload(strikeRow) {
  if (!strikeRow || typeof strikeRow !== "object") return null;
  const liquidity =
    strikeRow.liquidity && typeof strikeRow.liquidity === "object"
      ? {
          spreadPct: strikeRow.liquidity.spreadPct ?? null,
          openInterest: strikeRow.liquidity.openInterest ?? null,
          volume: strikeRow.liquidity.volume ?? null,
        }
      : null;
  const compact = {
    strike: strikeRow.strike ?? null,
    premium: strikeRow.premium ?? null,
    premiumUsed: strikeRow.premiumUsed ?? strikeRow.primeUsed ?? null,
    primeUsed: strikeRow.primeUsed ?? null,
    conservativePremium: strikeRow.conservativePremium ?? null,
    bid: strikeRow.bid ?? null,
    ask: strikeRow.ask ?? null,
    mid: strikeRow.mid ?? null,
    last: strikeRow.last ?? null,
    spread: strikeRow.spread ?? null,
    spreadPct: strikeRow.spreadPct ?? null,
    annualizedYield: strikeRow.annualizedYield ?? null,
    impliedVolatility: strikeRow.impliedVolatility ?? null,
    popEstimate: strikeRow.popEstimate ?? null,
    popProfitEstimated: strikeRow.popProfitEstimated ?? null,
    openInterest: strikeRow.openInterest ?? null,
    volume: strikeRow.volume ?? null,
    conId: strikeRow.conId ?? null,
    localSymbol: strikeRow.localSymbol ?? null,
    delta: strikeRow.delta ?? null,
    gamma: strikeRow.gamma ?? null,
    theta: strikeRow.theta ?? null,
    vega: strikeRow.vega ?? null,
  };
  if (liquidity) compact.liquidity = liquidity;
  return compact;
}

const JOURNAL_TECHNICAL_CANDLE_LIMIT = 220;

function trimOhlcCandlesForJournal(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const trimmed = raw.slice(-JOURNAL_TECHNICAL_CANDLE_LIMIT);
  const compact = trimmed
    .map((candle) => {
      if (!candle || typeof candle !== "object") return null;
      const close = candle.close ?? null;
      if (close == null) return null;
      return {
        date: candle.date ?? null,
        open: candle.open ?? null,
        high: candle.high ?? null,
        low: candle.low ?? null,
        close,
        volume: candle.volume ?? null,
      };
    })
    .filter(Boolean);
  return compact.length > 0 ? compact : null;
}

function buildAutoJournalCandidatePayload(candidate) {
  if (!candidate || typeof candidate !== "object") return candidate;
  const raw = candidate.raw && typeof candidate.raw === "object" ? candidate.raw : null;
  const diagnosticsV12 =
    candidate.diagnosticsV12 && typeof candidate.diagnosticsV12 === "object"
      ? {
          hv10: candidate.diagnosticsV12.hv10 ?? null,
          hv20: candidate.diagnosticsV12.hv20 ?? null,
          hv30: candidate.diagnosticsV12.hv30 ?? null,
          safeStrikeIv: candidate.diagnosticsV12.safeStrikeIv ?? null,
          atmIv: candidate.diagnosticsV12.atmIv ?? null,
          ivHvRatio: candidate.diagnosticsV12.ivHvRatio ?? null,
          ivHvEdge: candidate.diagnosticsV12.ivHvEdge ?? null,
          dailyChangePct: candidate.diagnosticsV12.dailyChangePct ?? null,
          zScore20: candidate.diagnosticsV12.zScore20 ?? null,
          volumeVsAvgRatio: candidate.diagnosticsV12.volumeVsAvgRatio ?? null,
          challengerCandidate: candidate.diagnosticsV12.challengerCandidate ?? null,
          challengerReasons: Array.isArray(candidate.diagnosticsV12.challengerReasons)
            ? candidate.diagnosticsV12.challengerReasons.slice(0, 10)
            : [],
        }
      : null;

  const compact = {
    ticker: candidate.ticker ?? candidate.symbol ?? null,
    symbol: candidate.symbol ?? candidate.ticker ?? null,
    name: candidate.name ?? null,
    price: candidate.price ?? candidate.currentPrice ?? null,
    currentPrice: candidate.currentPrice ?? candidate.price ?? null,
    underlyingPrice: candidate.underlyingPrice ?? null,
    rank: candidate.rank ?? null,
    yahooRank: candidate.yahooRank ?? candidate.rank ?? null,
    ibkrRank: candidate.ibkrRank ?? null,
    selectedMode:
      candidate.selectedMode ?? candidate.finalDisplayMode ?? candidate.recommendedMode ?? null,
    expiration: candidate.expiration ?? candidate.targetExpiration ?? null,
    targetExpiration: candidate.targetExpiration ?? candidate.expiration ?? null,
    selectedExpiration: candidate.selectedExpiration ?? candidate.targetExpiration ?? null,
    dteAtScan: candidate.dteAtScan ?? candidate.dteDays ?? null,
    expectedMove: candidate.expectedMove ?? null,
    expectedMoveLow: candidate.expectedMoveLow ?? candidate.lowerBound ?? null,
    expectedMoveHigh: candidate.expectedMoveHigh ?? null,
    lowerBound: candidate.lowerBound ?? candidate.expectedMoveLow ?? null,
    safeStrike: buildAutoJournalStrikePayload(candidate.safeStrike),
    aggressiveStrike: buildAutoJournalStrikePayload(candidate.aggressiveStrike),
    finalScore: candidate.finalScore ?? candidate.proFinalScore ?? null,
    proFinalScore: candidate.proFinalScore ?? null,
    qualityScore: candidate.qualityScore ?? null,
    eliteScore: candidate.eliteScore ?? null,
    eliteBadge: candidate.eliteBadge ?? null,
    support: candidate.support ?? candidate.supportResistance?.support ?? null,
    resistance: candidate.resistance ?? candidate.supportResistance?.resistance ?? null,
    supportStatus:
      candidate.supportStatus ?? candidate.supportResistance?.supportStatus ?? null,
    targetPremium: candidate.targetPremium ?? candidate.minPremium ?? null,
    minPremium: candidate.minPremium ?? null,
    hasUpcomingEarningsBeforeExpiration: candidate.hasUpcomingEarningsBeforeExpiration ?? false,
    hasEarningsBeforeExpiration: candidate.hasEarningsBeforeExpiration ?? false,
    earningsDate: candidate.earningsDate ?? null,
    nextEarningsDate: candidate.nextEarningsDate ?? null,
    earningsDaysUntil: candidate.earningsDaysUntil ?? null,
    marketCap: candidate.marketCap ?? raw?.quote?.marketCap ?? null,
    averageVolume:
      candidate.averageVolume ??
      raw?.quote?.averageDailyVolume3Month ??
      raw?.quote?.regularMarketVolume ??
      null,
    quoteType: candidate.quoteType ?? raw?.quote?.quoteType ?? null,
    rsi:
      typeof candidate.rsi === "number"
        ? candidate.rsi
        : typeof raw?.technicals?.rsi === "number"
        ? raw.technicals.rsi
        : null,
    source: candidate.source ?? null,
    poolSource: candidate.poolSource ?? null,
    researchExpanded: candidate.researchExpanded === true,
    researchOnlyCandidate: candidate.researchOnlyCandidate === true,
    optionsSource: candidate.optionsSource ?? null,
    techniqueSource: candidate.techniqueSource ?? null,
    portfolioMode: candidate.portfolioMode ?? null,
    diagnosticsV12,
  };

  const supportResistance = {};
  if (compact.support != null) supportResistance.support = compact.support;
  if (compact.resistance != null) supportResistance.resistance = compact.resistance;
  if (compact.supportStatus != null) supportResistance.supportStatus = compact.supportStatus;
  if (Object.keys(supportResistance).length > 0) compact.supportResistance = supportResistance;

  const ohlcSource =
    candidate.ohlcCandles ??
    candidate.supportResistance?.ohlcCandles ??
    raw?.ohlcCandles ??
    null;
  const journalOhlcCandles = trimOhlcCandlesForJournal(ohlcSource);
  if (journalOhlcCandles) {
    compact.ohlcCandles = journalOhlcCandles;
  } else {
    const closes =
      candidate.priceSeries?.closes ??
      candidate.technicals?.closes60 ??
      raw?.technicals?.closes60 ??
      null;
    if (Array.isArray(closes) && closes.length >= 2) {
      compact.priceSeries = {
        interval: candidate.priceSeries?.interval ?? "1d",
        closes: closes.slice(-JOURNAL_TECHNICAL_CANDLE_LIMIT),
        count: Math.min(closes.length, JOURNAL_TECHNICAL_CANDLE_LIMIT),
      };
    }
  }

  if (raw) {
    const rawCompact = {};
    if (raw.expiration != null) rawCompact.expiration = raw.expiration;
    const quote = {};
    if (raw.quote?.marketCap != null) quote.marketCap = raw.quote.marketCap;
    if (raw.quote?.quoteType != null) quote.quoteType = raw.quote.quoteType;
    if (raw.quote?.averageDailyVolume3Month != null) {
      quote.averageDailyVolume3Month = raw.quote.averageDailyVolume3Month;
    }
    if (raw.quote?.regularMarketVolume != null) {
      quote.regularMarketVolume = raw.quote.regularMarketVolume;
    }
    if (Object.keys(quote).length > 0) rawCompact.quote = quote;
    if (typeof raw.technicals?.rsi === "number") {
      rawCompact.technicals = { rsi: raw.technicals.rsi };
    }
    if (Object.keys(rawCompact).length > 0) compact.raw = rawCompact;
  }

  if (candidate.ibkrDirect) {
    const ibkr = candidate.ibkrDirect;
    const puts = Array.isArray(ibkr.putCandidates)
      ? ibkr.putCandidates
      : Array.isArray(ibkr.raw?.putCandidates)
      ? ibkr.raw.putCandidates
      : [];
    const findPut = (strike) => {
      const st = Number(strike);
      if (!Number.isFinite(st)) return null;
      const row = puts.find((p) => Number(p?.strike) === st);
      if (!row || typeof row !== "object") return null;
      return {
        strike: row.strike ?? null,
        bid: row.bid ?? null,
        ask: row.ask ?? null,
        mid: row.mid ?? null,
        last: row.last ?? null,
        spread: row.spread ?? null,
        spreadPct: row.spreadPct ?? null,
        primeUsed: row.primeUsed ?? null,
        volume: row.volume ?? null,
        openInterest: row.openInterest ?? null,
        optionVolume: row.optionVolume ?? null,
        putOpenInterest: row.putOpenInterest ?? null,
        callOpenInterest: row.callOpenInterest ?? null,
        impliedVolatility: row.impliedVolatility ?? null,
        conId: row.conId ?? null,
        localSymbol: row.localSymbol ?? null,
        tradingClass: row.tradingClass ?? null,
        exchange: row.exchange ?? null,
        currency: row.currency ?? null,
        multiplier: row.multiplier ?? null,
        delta: row.delta ?? null,
        gamma: row.gamma ?? null,
        theta: row.theta ?? null,
        vega: row.vega ?? null,
        modelPrice: row.modelPrice ?? null,
        modelGreeksTimestamp: row.modelGreeksTimestamp ?? null,
        modelGreeksSource: row.modelGreeksSource ?? null,
        mark: row.mark ?? null,
        quoteTimestamp: row.quoteTimestamp ?? null,
      };
    };
    compact.ibkrDirect = {
      underlyingPrice: ibkr.underlyingPrice ?? null,
      scanCompletedAt: ibkr.scanCompletedAt ?? null,
      marketDataTypeReceivedLabel: ibkr.marketDataTypeReceivedLabel ?? null,
      expiration: ibkr.expiration ?? null,
    };
    if (!compact.optionsSource && !compact.source) compact.optionsSource = "IBKR live";
    const safeSt = compact.safeStrike?.strike;
    const aggSt = compact.aggressiveStrike?.strike;
    if (safeSt != null) compact.ibkrSafePutRow = findPut(safeSt);
    if (aggSt != null) compact.ibkrAggressivePutRow = findPut(aggSt);
  }

  return compact;
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
  const body = {
    candidates,
    topN,
    scanTimestamp,
    scanSessionId,
    selectedExpiration,
    captureSource,
    dteAtScan,
  };
  const bodyStr = JSON.stringify(body);
  console.info("[AUTO_JOURNAL_DEBUG_BEFORE_FETCH]", {
    captureTopN: topN,
    rawCandidates: Array.isArray(candidates) ? candidates.length : 0,
    compactCandidates: Array.isArray(candidates) ? candidates.length : 0,
    firstCandidateKeys: Object.keys(candidates?.[0] || {}),
    firstCandidate: candidates?.[0] ?? null,
    approxPayloadKb: Math.round(bodyStr.length / 1024),
    captureSource,
    scanSessionId,
  });
  const response = await fetch(`${API_BASE}/journal/wheel-validation/capture`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: bodyStr,
  });

  let payload = {};
  let responseText = "";
  try {
    responseText = await response.text();
    payload = responseText ? JSON.parse(responseText) : {};
  } catch {
    payload = { error: responseText || `HTTP ${response.status}` };
  }

  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.statusText = response.statusText;
    error.responseText = responseText;
    error.payloadKb = Math.round(bodyStr.length / 1024);
    throw error;
  }

  return payload;
}

/**
 * Archive forensic best-effort du funnel Yahoo/IBKR (Phase 1).
 * - N'altère JAMAIS le scan : aucune exception remontée, console.warn seulement.
 * - Timeout court (5 s) pour ne pas retenir de ressources.
 * - Ne refetch rien : `payload` est déjà construit depuis l'état du dashboard.
 */
function callScanFunnelArchive(payload) {
  try {
    if (!payload?.scanSessionId) return;
    const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    const timeoutId = controller ? setTimeout(() => controller.abort(), 5000) : null;
    void fetch(`${API_BASE}/scan-funnel/archive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller?.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          console.warn("[SCAN_FUNNEL_ARCHIVE_WARN]", {
            scanSessionId: payload.scanSessionId,
            status: response.status,
          });
        }
      })
      .catch((error) => {
        console.warn("[SCAN_FUNNEL_ARCHIVE_WARN]", {
          scanSessionId: payload.scanSessionId,
          error: error?.message || String(error),
        });
      })
      .finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
  } catch (error) {
    console.warn("[SCAN_FUNNEL_ARCHIVE_WARN]", { error: error?.message || String(error) });
  }
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
      marketDataType: 1,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }

  return payload;
}

// Taille de lot IBKR : source de vérité = backend (IBKR_SCAN_BATCH_SIZE).
// Permet d'envoyer Depth 30 en 1 lot de 30 et Depth 50 en 1 lot de 50,
// au lieu de l'ancien découpage 10 puis 5+5+5. Fallback prudent si offline.
const IBKR_UI_SCAN_BATCH_SIZE_FALLBACK = 50;
const IBKR_UI_SCAN_BATCH_SIZE_MIN = 5;
const IBKR_UI_SCAN_BATCH_SIZE_MAX = 50;

async function fetchIbkrScanBatchSize() {
  try {
    const response = await fetch(`${API_BASE}/ibkr/scan-config`);
    if (!response.ok) return IBKR_UI_SCAN_BATCH_SIZE_FALLBACK;
    const payload = await response.json();
    const raw = Number(payload?.ibkrScanBatchSize);
    if (!Number.isFinite(raw)) return IBKR_UI_SCAN_BATCH_SIZE_FALLBACK;
    return Math.max(
      IBKR_UI_SCAN_BATCH_SIZE_MIN,
      Math.min(IBKR_UI_SCAN_BATCH_SIZE_MAX, Math.trunc(raw))
    );
  } catch {
    return IBKR_UI_SCAN_BATCH_SIZE_FALLBACK;
  }
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
    no_bid_ask: "IBKR quote absente / bid-ask manquant",
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
    return {
      bucket: "cryptoBlocked",
      label: "Crypto bloqués / exclus",
      reasons: [meta.cryptoBlockReason || CRYPTO_BLOCK_REASON],
    };
  }
  if (meta.qualityTier === "Inconnu à valider") {
    return { bucket: "unknownReview", label: "Inconnus à valider", reasons: ["Ajouter à tickerMeta.js pour le classer"] };
  }
  if (shouldGlobalSpreadReject(card)) {
    const activeSpread =
      getActiveSpreadPctForSelectedMode({
        safeSpreadPct: safe,
        aggressiveSpreadPct: agg,
        card,
      }) ?? Math.max(safe ?? 0, agg ?? 0);
    return {
      bucket: "spreadRejected",
      label: "Rejetés pour spread",
      reasons: [`spread extrême ${activeSpread.toFixed(0)}%`],
    };
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
      badgeClass: "border-slate-700 bg-slate-800/50 text-slate-400",
      textClass: "text-slate-500",
      metricTone: "default",
    };
  }
  if (pct <= 5) {
    return {
      label: "liquide",
      reason: "spread faible",
      badgeClass: "border-emerald-800 bg-emerald-950/40 text-emerald-400",
      textClass: "text-emerald-400",
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
      badgeClass: "border-amber-700 bg-amber-950/40 text-amber-300",
      textClass: "text-amber-300",
      metricTone: "warn",
    };
  }
  return {
    label: "non actionnable",
    reason: "spread trop large",
    badgeClass: "border-rose-800 bg-rose-950/40 text-rose-400",
    textClass: "text-rose-400",
    metricTone: "bad",
  };
}

function classifyEliteBadge(eliteBadge) {
  const badge = String(eliteBadge || "");
  if (badge === "Elite") return "border-emerald-300 bg-emerald-950/40 text-emerald-300";
  if (badge === "Strong") return "border-cyan-300 bg-cyan-50 text-cyan-800";
  if (badge === "Moderate") return "border-amber-700 bg-amber-950/40 text-amber-300";
  return "border-rose-300 bg-rose-950/40 text-rose-800";
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
    return { label: "À surveiller", tone: "warn", className: "border-amber-800 bg-amber-950/40 text-amber-300" };
  }
  const { finalDisplayMode: mode, finalDisplayGrade: grade } = getFinalDisplayRecommendation(item);
  if (mode === "REJECT" || mode === "SAFE" || mode === "AGGRESSIVE") {
    if (mode === "REJECT") {
      return { label: "Non actionnable", tone: "bad", className: "border-rose-800 bg-rose-950/40 text-rose-400" };
    }
    if (grade === "A" || grade === "B") {
      return { label: "Actionnable", tone: "good", className: "border-emerald-800 bg-emerald-950/40 text-emerald-400" };
    }
    if (grade === "WATCH") {
      return { label: "À surveiller", tone: "warn", className: "border-amber-800 bg-amber-950/40 text-amber-300" };
    }
    return { label: "Non actionnable", tone: "bad", className: "border-rose-800 bg-rose-950/40 text-rose-400" };
  }
  const profile = getIbkrActionabilityProfile(item);
  if (!profile || typeof profile !== "object") {
    return { label: "À surveiller", tone: "warn", className: "border-amber-800 bg-amber-950/40 text-amber-300" };
  }
  if (profile.bucket === 2) return { label: "Non actionnable", tone: "bad", className: "border-rose-800 bg-rose-950/40 text-rose-400" };
  if (profile.bucket === 0) return { label: "Actionnable", tone: "good", className: "border-emerald-800 bg-emerald-950/40 text-emerald-400" };
  return { label: "À surveiller", tone: "warn", className: "border-amber-800 bg-amber-950/40 text-amber-300" };
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

/** Alignée sur mergeIbkrCallMetricsIntoState (server.js) — sommes en observabilité seulement. */
const IBKR_SNAPSHOT_TOTAL_SUM_KEYS = [
  "totalStockQualifyCalls",
  "totalOptionQualifyCalls",
  "totalOptionChainRequests",
  "totalStockMarketDataRequests",
  "totalOptionMarketDataRequests",
  "totalExpectedMoveOptionRequests",
  "totalPutCandidateOptionRequests",
  "totalExpectedMoveContractsRequested",
  "totalPutCandidateContractsRequested",
  "totalPutCandidateContractsActuallyRequested",
  "totalPutQuotesAvoidedByQuickGate",
  "totalQuickGateEvaluated",
  "totalQuickGateSkipped",
  "totalQuickGateFallback",
  "totalQuickGatePassed",
  "totalQuickGateRejected",
  "totalQuickGateSavedApproxCalls",
  "totalCancelMarketDataCalls",
  "totalMarketDataWaits",
  "totalTimeouts",
  "totalRawStrikesChecked",
  "totalValidCallStrikesCount",
  "totalValidPutStrikesCount",
  "totalApproxIbkrCalls",
  "totalApproxCalls",
  "totalDurationMs",
  "totalTickersObserved",
  "totalOptionQualifyCacheHits",
  "totalOptionMarketDataCacheHits",
  "totalStockMarketDataCacheHits",
  "totalOptionChainCacheHits",
  "totalDuplicateOptionQualifyAvoided",
  "totalDuplicateOptionMarketDataAvoided",
];

function incrementIbkrPayloadReasonCounts(target, source) {
  if (!target || typeof target !== "object") return target;
  if (!source || typeof source !== "object") return target;
  for (const [k, v] of Object.entries(source)) {
    const key = String(k || "").trim() || "unknown";
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    target[key] = (target[key] || 0) + n;
  }
  return target;
}

function extractIbkrPayloadRejectionReasonsSnapshot(payload) {
  const top = payload?.rejectionReasons;
  if (top && typeof top === "object" && Object.keys(top).length > 0) return top;
  const inner = payload?.ibkrCallMetrics?.rejectionReasons;
  if (inner && typeof inner === "object") return inner;
  return {};
}

function mergeIbkrCallMetricSnapshotsAcrossPayloads(payloads) {
  let sawMetrics = false;
  const totals = {};
  const bySymbol = {};
  const twoPhaseAny = Array.isArray(payloads)
    ? payloads.some((p) => p?.twoPhaseEnabled === true)
    : false;

  for (const p of payloads || []) {
    const metrics = p?.ibkrCallMetrics;
    if (!metrics || typeof metrics !== "object") continue;
    sawMetrics = true;
    const t = metrics.totals ?? {};
    for (const key of IBKR_SNAPSHOT_TOTAL_SUM_KEYS) {
      const n = Number(t[key]);
      if (!Number.isFinite(n)) continue;
      totals[key] = (totals[key] || 0) + n;
    }
    const bs = metrics.bySymbol ?? {};
    for (const [rawSym, row] of Object.entries(bs)) {
      const sym = String(rawSym || "").trim().toUpperCase();
      if (!sym || !row || typeof row !== "object") continue;
      const prev = bySymbol[sym];
      bySymbol[sym] =
        prev && typeof prev === "object" ? { ...prev, ...row } : { ...row };
    }
  }

  const approxIb = Number(totals.totalApproxIbkrCalls);
  if (
    sawMetrics &&
    !Number.isFinite(Number(totals.totalApproxCalls)) &&
    Number.isFinite(approxIb)
  ) {
    totals.totalApproxCalls = approxIb;
  }

  const metricsOut = sawMetrics
    ? { twoPhaseEnabled: twoPhaseAny, totals, bySymbol }
    : null;
  return { sawMetrics, twoPhaseAny, metricsOut };
}

function pickYahooIbkrTickerFromRow(row) {
  const raw = row?.ticker ?? row?.symbol ?? "";
  return String(raw || "").trim().toUpperCase();
}

function toIbkrRankLookupMap(rankMapRaw) {
  if (rankMapRaw instanceof Map) return rankMapRaw;
  const out = new Map();
  if (!rankMapRaw || typeof rankMapRaw !== "object") return out;
  for (const [k, v] of Object.entries(rankMapRaw)) {
    const sym = String(k || "").trim().toUpperCase();
    const n = Number(v);
    if (!sym || !Number.isFinite(n)) continue;
    out.set(sym, n);
  }
  return out;
}

function ibkrRejectedAggressiveStrikeForForensicExport(rej) {
  const a = rej?.aggressiveStrike;
  if (a && typeof a === "object" && Number.isFinite(Number(a.strike))) return Number(a.strike);
  if (Number.isFinite(Number(a))) return Number(a);
  return null;
}

/** Champs diagnostics IBKR rejets uniquement — restitués par server.js sans logique métier. */
function pickIbkrRejectedObservabilityForForensicExport(rej) {
  if (!rej || typeof rej !== "object") return {};
  return {
    rejectionReason: rej.rejectionReason ?? null,
    timeoutStage: rej.timeoutStage ?? null,
    underlyingPrice: rej.underlyingPrice ?? null,
    lowerBound: rej.lowerBound ?? null,
    targetPremium: rej.targetPremium ?? null,
    aggressiveStrike: ibkrRejectedAggressiveStrikeForForensicExport(rej),
    aggressiveBid: rej.aggressiveBid ?? null,
    aggressiveAsk: rej.aggressiveAsk ?? null,
    aggressiveMid: rej.aggressiveMid ?? null,
    aggressivePrimeUsed: rej.aggressivePrimeUsed ?? null,
    aggressiveSpreadPct: rej.aggressiveSpreadPct ?? null,
    aggressiveYieldPct: rej.aggressiveYieldPct ?? null,
    aggressiveOtmPct: rej.aggressiveOtmPct ?? null,
    aggressiveDistanceFromLowerBound: rej.aggressiveDistanceFromLowerBound ?? null,
    bestSafeStrike: rej.bestSafeStrike ?? null,
    bestSafeBid: rej.bestSafeBid ?? null,
    bestSafeAsk: rej.bestSafeAsk ?? null,
    bestSafeMid: rej.bestSafeMid ?? null,
    bestSafePrimeUsed: rej.bestSafePrimeUsed ?? null,
    bestSafeSpreadPct: rej.bestSafeSpreadPct ?? null,
    bestSafeYieldPct: rej.bestSafeYieldPct ?? null,
    bestSafeOtmPct: rej.bestSafeOtmPct ?? null,
    bestSafeDistanceFromLowerBound: rej.bestSafeDistanceFromLowerBound ?? null,
    premiumDeficitDollar: rej.premiumDeficitDollar ?? null,
    premiumDeficitPct: rej.premiumDeficitPct ?? null,
    premiumCoveragePct: rej.premiumCoveragePct ?? null,
    putCandidatesCount: rej.putCandidatesCount ?? null,
    topPutCandidatesSummary: rej.topPutCandidatesSummary ?? null,
    probabilityOfProfit: rej.probabilityOfProfit ?? null,
  };
}

/**
 * Rang Yahoo utilisé après scan auto (priorité carte diagnostics).
 * @param {{ ibkrDirectResult: object|null, yahooReturnedCandidates?: unknown[], yahooRankForIbkrBySymbol?: Map|Record<string, number> }} opts
 */
function buildIbkrYahooIbkrForensicExportRows(opts) {
  const result = opts?.ibkrDirectResult;
  if (!result || result.ok !== true) return [];

  const rankLookup = toIbkrRankLookupMap(opts?.yahooRankForIbkrBySymbol);

  const testedOrder = [
    ...(Array.isArray(result.testedSymbols)
      ? result.testedSymbols
      : []),
  ]
    .map((t) => String(t || "").trim().toUpperCase())
    .filter(Boolean);
  const testedSet = new Set(testedOrder);

  const retainedSymbols = (
    Array.isArray(result.shortlist) ? result.shortlist : []
  )
    .map((r) => String(r?.symbol || "").trim().toUpperCase())
    .filter(Boolean);
  const retainedSet = new Set(retainedSymbols);

  const rejRows = Array.isArray(result.rejected) ? result.rejected : [];
  const rejFirstBySym = new Map();
  for (const r of rejRows) {
    const sym = String(r?.symbol || "").trim().toUpperCase();
    if (sym && !rejFirstBySym.has(sym)) rejFirstBySym.set(sym, r);
  }

  const poolFromYahoo = (opts?.yahooReturnedCandidates || [])
    .map(pickYahooIbkrTickerFromRow)
    .filter(Boolean);
  const poolOrder = [...new Set([...poolFromYahoo, ...testedOrder, ...rejFirstBySym.keys()])];

  /** @type {unknown[]} */
  const outRows = [];
  function yahooRankFor(sym) {
    const n = rankLookup.get(sym);
    return Number.isFinite(Number(n)) ? Number(n) : null;
  }

  for (const sym of poolOrder) {
    const tested = testedSet.has(sym);
    let disposition = "nonTested";
    if (tested) {
      if (retainedSet.has(sym)) disposition = "retained";
      else if (rejFirstBySym.has(sym)) disposition = "rejected";
      else disposition = "unknown";
    }
    const rej = rejFirstBySym.get(sym);
    const retainedRow = (Array.isArray(result.shortlist) ? result.shortlist : []).find(
      (x) => String(x?.symbol || "").trim().toUpperCase() === sym
    );

    /** @type {number|null|string} */
    let durationMs = null;
    if (rej) {
      durationMs =
        rej.durationMs ??
        rej?.ibkrCallMetrics?.durationMs ??
        null;
    } else if (retainedRow) {
      durationMs = retainedRow.durationMs ?? null;
    }

    const forensicObs =
      disposition === "rejected" ? pickIbkrRejectedObservabilityForForensicExport(rej) : {};

    outRows.push({
      ticker: sym,
      yahooRank: yahooRankFor(sym),
      tested,
      disposition,
      reason:
        disposition === "nonTested"
          ? ""
          : disposition === "retained"
          ? "OK"
          : String(rej?.reason ?? rej?.status ?? "").trim(),
      rawError: disposition === "rejected" ? (rej?.error ?? null) : null,
      durationMs,
      ...forensicObs,
    });
  }
  return outRows;
}

function escapeCsvForensicCell(value) {
  if (value == null) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function stringifyIbkrForensicRowsCsv(rows) {
  const header = [
    "ticker",
    "yahooRank",
    "disposition",
    "reason",
    "targetPremium",
    "bestSafePrimeUsed",
    "premiumCoveragePct",
    "premiumDeficitDollar",
    "bestSafeStrike",
    "bestSafeSpreadPct",
    "bestSafeOtmPct",
    "bestSafeDistanceFromLowerBound",
    "aggressiveStrike",
    "aggressivePrimeUsed",
    "aggressiveSpreadPct",
    "lowerBound",
    "underlyingPrice",
    "durationMs",
    "rawError",
  ];
  const lines = [header.join(",")];
  for (const r of rows || []) {
    lines.push(
      [
        escapeCsvForensicCell(r?.ticker),
        escapeCsvForensicCell(r?.yahooRank),
        escapeCsvForensicCell(r?.disposition),
        escapeCsvForensicCell(r?.reason),
        escapeCsvForensicCell(r?.targetPremium),
        escapeCsvForensicCell(r?.bestSafePrimeUsed),
        escapeCsvForensicCell(r?.premiumCoveragePct),
        escapeCsvForensicCell(r?.premiumDeficitDollar),
        escapeCsvForensicCell(r?.bestSafeStrike),
        escapeCsvForensicCell(r?.bestSafeSpreadPct),
        escapeCsvForensicCell(r?.bestSafeOtmPct),
        escapeCsvForensicCell(r?.bestSafeDistanceFromLowerBound),
        escapeCsvForensicCell(r?.aggressiveStrike),
        escapeCsvForensicCell(r?.aggressivePrimeUsed),
        escapeCsvForensicCell(r?.aggressiveSpreadPct),
        escapeCsvForensicCell(r?.lowerBound),
        escapeCsvForensicCell(r?.underlyingPrice),
        escapeCsvForensicCell(r?.durationMs),
        escapeCsvForensicCell(r?.rawError),
      ].join(",")
    );
  }
  return lines.join("\r\n");
}

function triggerDashboardFileDownload(contents, mime, filename) {
  try {
    const blob = new Blob([contents], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  } catch (_e) {
    /* eslint no-empty -- fallback silencieux : diagnostic export */
  }
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

  const rejectionReasons = {};
  for (const p of payloads) {
    incrementIbkrPayloadReasonCounts(
      rejectionReasons,
      extractIbkrPayloadRejectionReasonsSnapshot(p),
    );
  }

  const { twoPhaseAny, metricsOut } = mergeIbkrCallMetricSnapshotsAcrossPayloads(payloads);
  const twoPhaseEnabledRoot = Array.isArray(payloads)
    ? payloads.some((p) => p?.twoPhaseEnabled === true)
    : false;
  const progressiveSafeScanEnabledRoot = Array.isArray(payloads)
    ? payloads.find((p) => typeof p?.progressiveSafeScanEnabled === "boolean")
        ?.progressiveSafeScanEnabled ?? null
    : null;
  const maxValidPutsEffectiveRoot = Array.isArray(payloads)
    ? payloads
        .map((p) => Number(p?.maxValidPutsEffective))
        .find((n) => Number.isFinite(n)) ?? null
    : null;

  /** Observabilité seulement — miroir fusion progressive des batches. */
  const ibkrCallMetrics =
    metricsOut != null
      ? {
          ...metricsOut,
          twoPhaseEnabled: twoPhaseAny,
          rejectionReasons: { ...rejectionReasons },
        }
      : null;

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
    twoPhaseEnabled: twoPhaseEnabledRoot,
    progressiveSafeScanEnabled: progressiveSafeScanEnabledRoot,
    maxValidPutsEffective: maxValidPutsEffectiveRoot,
    rejectionReasons,
    ibkrCallMetrics,
    yahooReturnedPoolSize: poolSize,
    finalDisplayedTarget,
    totalKeptCollected: shortlist.length,
    retainedNotDisplayed: Math.max(0, shortlist.length - finalDisplayedTarget),
    testedSymbols,
    rejectedReplaced: Math.max(0, testedSymbols.length - shortlist.length),
    nonTestedCandidates: Math.max(0, poolSize - testedSymbols.length),
    scanTiming: mergedScanTiming,
    durationMs: hasTiming ? Math.round(aggTotalMs) : null,
    ibkrDurationMs: hasTiming ? Math.round(aggIbkrMs) : null,
    progressiveIbkrBatchCount: Array.isArray(payloads) ? payloads.length : 0,
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
      className: "border-emerald-800 bg-emerald-950/40 text-emerald-300",
    };
  }
  if (status === "different") {
    return {
      label: "Différent",
      summary: "IBKR diffère de Yahoo — vérifier les détails",
      className: "border-amber-800 bg-amber-950/40 text-amber-300",
    };
  }
  if (status === "ibkr_unavailable") {
    return {
      label: "IBKR indisponible",
      summary: "IBKR n’a pas pu valider ce ticker",
      className: "border-rose-800 bg-rose-950/40 text-rose-800",
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
      className: "border-rose-800 bg-rose-950/40 text-rose-800",
    };
  }
  return null;
}

function IbkrStrikeBlock({ title, strike }) {
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-4">
      <p className="mb-3 text-sm font-semibold text-slate-100">{title}</p>
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
    <Card className="mb-6 rounded-[28px] border-slate-700 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl text-slate-100">
              <ShieldCheck className="h-5 w-5 text-emerald-400" />
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
            <label className="mb-2 block text-sm font-medium text-slate-300">Symbole</label>
            <Input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              className="w-full rounded-xl border-slate-700"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Expiration</label>
            <Input
              value={expiration}
              onChange={(e) => setExpiration(e.target.value)}
              className="w-full rounded-xl border-slate-700"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Client ID</label>
            <Input
              type="number"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className="w-full rounded-xl border-slate-700"
            />
          </div>
          <div className="flex items-end">
            <Button className="w-full rounded-xl" onClick={onRun} disabled={loading}>
              Tester IBKR Shadow
            </Button>
          </div>
        </div>

        {loading && (
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-300">
            Analyse IBKR Shadow en cours…
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-400">
            Erreur réseau IBKR Shadow : {error}
          </div>
        )}

        {result?.ok === false && (
          <div className="rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-300">
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
  yahooReturnedCandidates = [],
  yahooRankForIbkrBySymbol,
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

  const rankLookup = useMemo(() => toIbkrRankLookupMap(yahooRankForIbkrBySymbol), [yahooRankForIbkrBySymbol]);

  const forensicExportRows = useMemo(
    () =>
      buildIbkrYahooIbkrForensicExportRows({
        ibkrDirectResult: result,
        yahooReturnedCandidates,
        yahooRankForIbkrBySymbol: rankLookup,
      }),
    [result, yahooReturnedCandidates, rankLookup],
  );

  const ibkrPanelYahooReturned = Number.isFinite(Number(result?.yahooReturnedPoolSize))
    ? Number(result.yahooReturnedPoolSize)
    : Array.isArray(yahooReturnedCandidates)
    ? yahooReturnedCandidates.length
    : 0;

  const ibkrPanelTestedCount =
    Array.isArray(result?.testedSymbols) && result.testedSymbols.length
      ? result.testedSymbols.length
      : Array.isArray(sentTickers)
      ? sentTickers.length
      : 0;

  const ibkrPanelTotalRetained = Number.isFinite(Number(result?.totalKeptCollected))
    ? Number(result.totalKeptCollected)
    : shortlist.length;

  const ibkrPanelNonTested = Number.isFinite(Number(result?.nonTestedCandidates))
    ? Number(result.nonTestedCandidates)
    : Math.max(0, ibkrPanelYahooReturned - ibkrPanelTestedCount);

  const rejectionReasonAggPanelLines = useMemo(() => {
    const rr = result?.rejectionReasons;
    if (rr && typeof rr === "object" && Object.keys(rr).length) {
      return Object.entries(rr)
        .map(([reason, count]) => [String(reason || "").trim() || "unknown", Number(count)])
        .filter(([, n]) => Number.isFinite(n) && n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, n]) => `${formatIbkrReason(reason)} (${n})`);
    }
    return aggregateIbkrRejectedReasons(rejected, 10).topLines;
  }, [result?.rejectionReasons, rejected]);

  const stampForensicFilename = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const handleForensicExportJson = useCallback(() => {
    const payloadObj = {
      exportedAtIso: new Date().toISOString(),
      rejectionReasonCounts: result?.rejectionReasons ?? null,
      progressiveIbkrBatchCount: result?.progressiveIbkrBatchCount ?? null,
      progressiveSafeScanEnabled: result?.progressiveSafeScanEnabled ?? null,
      maxValidPutsEffective: result?.maxValidPutsEffective ?? null,
      ibkrCallMetricsPresent: Boolean(result?.ibkrCallMetrics),
      rows: forensicExportRows,
    };
    triggerDashboardFileDownload(
      JSON.stringify(payloadObj, null, 2),
      "application/json",
      `ibkr-rejection-forensics-${stampForensicFilename()}.json`,
    );
  }, [forensicExportRows, result]);

  const handleForensicExportCsv = useCallback(() => {
    triggerDashboardFileDownload(
      stringifyIbkrForensicRowsCsv(forensicExportRows),
      "text/csv;charset=utf-8",
      `ibkr-rejection-forensics-${stampForensicFilename()}.csv`,
    );
  }, [forensicExportRows]);

  return (
    <Card className="mb-6 rounded-[28px] border-slate-700 shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-xl text-slate-100">
          <ShieldCheck className="h-5 w-5 text-emerald-400" />
          IBKR Direct Scan — lecture seule
          {result?.configuredDevScanMode === "auto" ? (
            <Badge className="rounded-full border border-slate-400 bg-slate-800 text-xs font-semibold uppercase tracking-wide text-slate-200">
              Mode auto
            </Badge>
          ) : null}
        </CardTitle>
        <p className="mt-1 text-sm text-slate-500">
          Scan IBKR indépendant. Yahoo construit la shortlist technique; IBKR valide les options en lecture
          seule. Aucun ordre envoyé.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Expiration IBKR : <span className="font-medium text-slate-300">{expiration || "—"}</span> ·
          Watchlist disponible : <span className="font-medium text-slate-300">{tickerCount}</span> titres
        </p>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          Tickers envoyés :{" "}
          <span className="font-medium text-slate-300">
            {sentTickers.length ? sentTickers.join(", ") : "—"}
          </span>
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Client ID start</label>
            <Input
              type="number"
              value={clientIdStart}
              onChange={(e) => setClientIdStart(e.target.value)}
              className="w-full rounded-xl border-slate-700"
            />
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Max titres</label>
            <Select
              value={String(maxTickers)}
              onChange={(e) => setMaxTickers(Number(e.target.value))}
              className="w-full rounded-xl border-slate-700"
            >
              <option value="3">3</option>
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </Select>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-slate-300">Top N</label>
            <Select
              value={String(topN)}
              onChange={(e) => setTopN(Number(e.target.value))}
              className="w-full rounded-xl border-slate-700"
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
          <div className="rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm font-medium text-amber-300">
            IBKR complet peut être lent : environ 9-10 sec par ticker. 20 titres peut dépasser 3 minutes.
          </div>
        )}

        {loading && (
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-300">
            Scan direct IBKR en cours…
          </div>
        )}

        {error && (
          <div className="rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-400">
            Erreur IBKR Direct Scan : {error}
          </div>
        )}

        {result?.ok === false && (
          <div className="rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-400">
            <p className="font-semibold">IBKR Direct Scan a retourné ok:false.</p>
            <p className="mt-1">Erreur : {result.error || "non retournée"}</p>
          </div>
        )}

        {result?.ok === true && (
          <div className="space-y-4">
            <div className="rounded-2xl border border-emerald-800 bg-emerald-950/40 p-4 text-sm font-medium text-emerald-300">
              Source active : IBKR Shadow Scan direct
            </div>

            {Boolean(result.warning || result.devScanEnabled) && (
              <div className="rounded-2xl border border-amber-700 bg-amber-950/40 p-4 text-sm font-semibold text-amber-950">
                {result.warning || "DEV TEST — données possiblement figées / non tradables"}
              </div>
            )}

            {hasBatchTimeout && (
              <div className="rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm font-semibold text-rose-400">
                Timeout IBKR : le batch a dépassé la limite avant de retourner les résultats. Réduire Max titres à 10 ou moins.
              </div>
            )}

            {isSuspiciousEmpty && (
              <div className="rounded-2xl border border-amber-700 bg-amber-100 p-4 text-sm font-semibold text-amber-300">
                {IBKR_TWS_EMPTY_MESSAGE}
              </div>
            )}

            {result?.ok === true &&
              !isSuspiciousEmpty &&
              Number(result?.kept ?? 0) === 0 &&
              rejected.length > 0 && (
                <div className="rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-950">
                  <p className="font-semibold">
                    0 retenu IBKR — rejets connus par symbole (pas une réponse « vide » type TWS si cette liste est
                    remplie).
                  </p>
                  <ul className="mt-2 max-h-56 list-disc space-y-1 overflow-y-auto pl-5 text-sm">
                    {rejected.slice(0, 30).map((r, i) => (
                      <li key={`ibkr-panel-rej-${r?.symbol ?? i}-${i}`}>
                        <span className="font-medium text-slate-100">{r?.symbol ?? "—"}</span>
                        {" — "}
                        {formatIbkrReason(r?.reason)}
                      </li>
                    ))}
                  </ul>
                  {rejectedReasonSummary.topLines.length > 0 && (
                    <p className="mt-2 text-xs text-amber-300">
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

            <div className="rounded-2xl border border-sky-900 bg-slate-900 p-4 text-sm text-slate-300">
              <p className="font-semibold text-slate-100">Traçabilité Yahoo → IBKR (panneau)</p>
              <div className="mt-3 grid gap-3 md:grid-cols-4">
                <Metric label="Yahoo Returned" value={String(ibkrPanelYahooReturned)} />
                <Metric label="IBKR Sent / Tested" value={String(ibkrPanelTestedCount)} />
                <Metric label="IBKR Retained" value={String(ibkrPanelTotalRetained)} tone="good" />
                <Metric label="IBKR Rejected" value={String(rejected.length)} tone={rejected.length ? "warn" : "default"} />
                <Metric label="IBKR Non Tested" value={String(ibkrPanelNonTested)} />
                <Metric label="Fusion IBKR (batches)" value={String(result.progressiveIbkrBatchCount ?? 1)} />
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-400">
                <span className="font-semibold text-slate-200">Top IBKR rejection reasons:</span>{" "}
                {rejectionReasonAggPanelLines.length
                  ? rejectionReasonAggPanelLines.join(" · ")
                  : "(aucune raison agrégée disponible pour ce résultat)"}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  type="button"
                  className="rounded-xl"
                  variant="outline"
                  disabled={result?.ok !== true || forensicExportRows.length === 0}
                  onClick={handleForensicExportJson}
                >
                  Export forensic JSON <Database className="ml-2 h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  className="rounded-xl"
                  variant="outline"
                  disabled={result?.ok !== true || forensicExportRows.length === 0}
                  onClick={handleForensicExportCsv}
                >
                  Export forensic CSV <Database className="ml-2 h-4 w-4" />
                </Button>
              </div>
              <p className="mt-2 text-[11px] leading-5 text-slate-500">
                CSV/JSON : une ligne par ticker du bassin Yahoo (quand disponible). Colonnes : ticker, yahooRank, tested,
                disposition (retained | rejected | nonTested | unknown), reason, rawError, durationMs.
              </p>
            </div>

            <ScanDiagBlock ibkrResult={result} yahooScanTiming={yahooScanTiming} />

            {perfSummary && (
              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-300">
                <p className="font-semibold text-slate-100">Instrumentation performance IBKR</p>
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
                  <p className="font-medium text-slate-100">Top 10 tickers les plus lents</p>
                  {slowestTickers.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">Aucune donnée de latence ticker.</p>
                  ) : (
                    <div className="mt-2 space-y-1 text-xs text-slate-300">
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
              <p className="font-semibold text-slate-100">Retenus IBKR total — bassin testé</p>
              {shortlist.map((item) => {
                const viewModel = buildIbkrRetainedViewModel(item);
                const selectedSpreadDisplay =
                  viewModel.selectedSpreadPct == null
                    ? "—"
                    : `${Number(viewModel.selectedSpreadPct).toFixed(2)}%`;
                return (
                  <div key={`ibkr-direct-${item.symbol}`} className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4">
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="text-lg font-semibold text-slate-100">{item.symbol}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Spot {formatMoneyOrDash(item.currentPrice ?? item.underlyingPrice)} · Borne basse{" "}
                          {formatMoneyOrDash(item.lowerBound)} · Prime cible {formatMoneyOrDash(item.targetPremium)}
                        </p>
                      </div>
                      <div className="text-sm font-medium text-slate-300">
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
                      <p className="mt-3 text-xs leading-5 text-slate-400">
                        {item.qualityReasons.filter(Boolean).join(" · ")}
                      </p>
                    )}
                  </div>
                );
              })}
              {shortlist.length === 0 && (
                <div className="rounded-2xl border border-dashed border-slate-600 bg-slate-900 p-6 text-center text-sm text-slate-500">
                  Aucun candidat IBKR direct retenu (mode LIVE).
                </div>
              )}
            </div>

            {shortlistDev.length > 0 && (
              <div className="space-y-3">
                <p className="font-semibold text-amber-950">Shortlist DEV — affichage hors marché uniquement</p>
                <p className="text-xs text-amber-300">
                  Ces cartes servent à tester l’UI ; ne pas utiliser pour prendre des décisions réelles.
                </p>
                {shortlistDev.map((item) => (
                  <div
                    key={`ibkr-direct-dev-${item.symbol}`}
                    className="rounded-2xl border border-amber-800 bg-amber-950/40/80 p-4"
                  >
                    <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
                      <div>
                        <p className="text-lg font-semibold text-slate-100">{item.symbol}</p>
                        <p className="mt-1 text-xs text-slate-400">
                          statut {formatIbkrReason(item.status)} · {formatIbkrReason(item.reason)}
                        </p>
                        <p className="mt-1 text-xs text-slate-500">
                          Spot {formatMoneyOrDash(item.currentPrice ?? item.underlyingPrice)} · Borne basse{" "}
                          {formatMoneyOrDash(item.lowerBound)} · Prime cible{" "}
                          {formatMoneyOrDash(item.targetPremium)}
                        </p>
                      </div>
                      <div className="text-sm font-medium text-slate-300">
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
              <div className="rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-300">
                <p className="mb-2 font-semibold">Principaux rejetés IBKR</p>
                <div className="space-y-1">
                  {rejected.slice(0, 10).map((row) => {
                    const isMissingQuote = row.reason === "no_bid_ask";
                    const isBelowPremium = row.reason === "no_safe_candidate_meets_min_premium";
                    return (
                    <div key={`ibkr-direct-rejected-${row.symbol}-${row.reason}`}>
                      {row.symbol || "—"} : {formatIbkrReason(row.reason)} · cible{" "}
                      {formatMoneyOrDash(row.targetPremium)} · agressif{" "}
                      {formatStrikeOrDash(row.aggressiveStrike?.strike)}
                      {isMissingQuote ? (
                        <> · <span className="font-semibold text-rose-400">quote absente</span></>
                      ) : isBelowPremium ? (
                        <> · meilleur bid safe{" "}{formatMoneyOrDash(row.bestSafeBid ?? row.aggressiveStrike?.bid)} vs cible {formatMoneyOrDash(row.targetPremium)}</>
                      ) : (
                        <> · bid {formatMoneyOrDash(row.aggressiveStrike?.bid)} · ask{" "}{formatMoneyOrDash(row.aggressiveStrike?.ask)} · prime{" "}{formatMoneyOrDash(row.aggressiveStrike?.primeUsed)}</>
                      )}
                      {" "}· durée{" "}
                      {row.durationMs == null ? "non retourné" : `${row.durationMs} ms`}
                    </div>
                    );
                  })}
                </div>
              </div>
            )}

            {(hasMissingIbkrDuration || isSuspiciousEmpty) && (
              <div className="rounded-2xl border border-slate-700 bg-slate-950 p-4 text-xs text-slate-100">
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

function CremeDeLaCremePanel({ items, ibkrBatchByTicker, yahooRankForIbkrBySymbol, seasonalityMap, onOpenDetail, highlightedTicker = null, sortBy = "quality" }) {
  const [activeBucket, setActiveBucket] = useState(null);
  const [expandedTickerCards, setExpandedTickerCards] = useState({});

  useEffect(() => {
    if (highlightedTicker) {
      setExpandedTickerCards(prev => ({ ...prev, [highlightedTicker]: true }));
    }
  }, [highlightedTicker]);

  const classified = useMemo(() => {
    // cryptoBlocked initialisé mais non rendu — évite un crash sur .push()
    const groups = Object.fromEntries([...CREAM_BUCKET_ORDER, "cryptoBlocked"].map(b => [b, []]));
    items.forEach((item) => {
      const info = getCreamQualityBucket(item);
      const score = getCreamQualityScore(item);
      groups[info.bucket].push({ item, info, score });
    });
    if (sortBy === "quality") {
      CREAM_BUCKET_ORDER.forEach(b => groups[b].sort((a, z) => z.score - a.score));
    }
    return groups;
  }, [items, sortBy]);

  // Buckets effectivement présents, dans l'ordre d'affichage.
  const availableBuckets = CREAM_BUCKET_ORDER.filter((b) => classified[b].length > 0);

  // Onglet courant : sélection utilisateur si elle reste valide, sinon premier bucket non vide.
  const currentBucket =
    activeBucket && availableBuckets.includes(activeBucket)
      ? activeBucket
      : availableBuckets[0] ?? null;

  if (!items.length || !currentBucket) return null;

  const visibleCount = items.length - (classified.cryptoBlocked?.length ?? 0);
  const toggleTickerCard = (ticker) => setExpandedTickerCards(prev => ({ ...prev, [ticker]: !prev[ticker] }));

  const group = classified[currentBucket];
  const cfg = CREAM_BUCKET_CONFIG[currentBucket];
  const isCompact = CREAM_COMPACT_BUCKETS.has(currentBucket);

  return (
    <div className="rounded-[12px] border border-[rgba(110,150,190,0.20)] bg-[#0a1726] overflow-hidden shadow-[0_0_0_1px_rgba(80,140,180,0.08),0_18px_60px_rgba(0,0,0,0.40)]">
      {/* En-tête panneau */}
      <div className="flex flex-wrap items-center gap-2 border-b border-[rgba(110,150,190,0.18)] px-4 py-3">
        <Layers3 className="h-4 w-4 text-amber-400 shrink-0" />
        <span className="text-sm font-bold text-[#f4f7fb]">Classement crème de la crème</span>
        <span className="ml-1 rounded-full bg-emerald-900/50 px-2 py-0.5 text-xs font-medium text-emerald-200">
          {visibleCount} admissibles
        </span>
      </div>

      {/* Onglets / buckets compacts */}
      <div className="flex flex-wrap items-stretch gap-1 border-b border-[rgba(110,150,190,0.18)] bg-[#081320] px-2 pt-1.5">
        {availableBuckets.map((bucket) => {
          const bGroup = classified[bucket];
          const bCfg = CREAM_BUCKET_CONFIG[bucket];
          const active = bucket === currentBucket;
          return (
            <button
              key={bucket}
              type="button"
              onClick={() => setActiveBucket(bucket)}
              className={cn(
                "flex items-center gap-1.5 rounded-t-[8px] border-b-2 px-3 py-2 text-xs font-semibold transition-colors",
                active
                  ? "border-emerald-400 bg-[#0a1726] text-[#f4f7fb]"
                  : "border-transparent text-[#91a8c4] hover:text-[#f4f7fb] hover:bg-white/5"
              )}
            >
              <span>{CREAM_BUCKET_ICON[bucket]}</span>
              <span>{bCfg.label}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 py-0.5 text-[11px] font-medium",
                  active ? "bg-emerald-500/20 text-emerald-200" : "bg-white/5 text-[#91a8c4]"
                )}
              >
                {bGroup.length}
              </span>
            </button>
          );
        })}
      </div>

      {/* Contenu du bucket actif */}
      {isCompact ? (
        <div className="max-h-[420px] overflow-y-auto divide-y divide-[rgba(110,150,190,0.12)]">
          {currentBucket === "unknownReview" && (
            <p className="px-4 py-2 text-xs italic text-[#6f86a6]">
              Ajouter ces tickers à tickerMeta.js pour les classer, ou les exclure.
            </p>
          )}
          {group.map(({ item }) => {
            const sym = String(item?.ticker ?? "").toUpperCase();
            const safeSpread = getSafeSpreadPct(item);
            const aggSpread = getAggressiveSpreadPct(item);
            return (
              <div key={sym} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2 text-xs">
                <span className="shrink-0 font-mono font-bold text-[#f4f7fb]">{sym}</span>
                {currentBucket === "unknownReview" && (
                  <>
                    <span className="italic text-[#6f86a6]">Nom indisponible</span>
                    <span className="text-[#91a8c4]">·</span>
                    <span className="italic text-[#91a8c4]">secteur non renseigné</span>
                    <span className="ml-auto rounded bg-white/5 px-1.5 py-0.5 text-[#6f86a6]">
                      à ajouter dans tickerMeta.js
                    </span>
                  </>
                )}
                {currentBucket === "spreadRejected" && (
                  <>
                    {safeSpread != null && (
                      <span className="text-[#ff9f1a]">safe {safeSpread.toFixed(0)}%</span>
                    )}
                    {aggSpread != null && (
                      <span className="text-[#ff9f1a]">agg {aggSpread.toFixed(0)}%</span>
                    )}
                    <span className="italic text-[#6f86a6]">spread trop large</span>
                    <button
                      type="button"
                      onClick={() => onOpenDetail(item)}
                      className="ml-auto rounded-[6px] border border-[rgba(110,150,190,0.30)] bg-[#0d2034] px-2.5 py-0.5 text-[11px] font-medium text-[#cfe0f2] hover:border-emerald-400 hover:text-white transition-colors"
                    >
                      Voir
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="max-h-[560px] overflow-y-auto overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-[#0b1a2b] text-[10px] uppercase tracking-wide text-[#7f97b6] shadow-[0_1px_0_rgba(110,150,190,0.18)]">
              <tr>
                <th className="px-2 py-2.5 text-left font-semibold">Rang</th>
                <th className="px-2 py-2.5 text-left font-semibold">Ticker</th>
                <th className="px-2 py-2.5 text-left font-semibold">Mode</th>
                <th className="px-2 py-2.5 text-right font-semibold">Prix actuel</th>
                <th className="px-2 py-2.5 text-right font-semibold">Strike</th>
                <th className="px-2 py-2.5 text-right font-semibold">Prime bid</th>
                <th className="px-2 py-2.5 text-right font-semibold">Rend. (sem.)</th>
                <th className="px-2 py-2.5 text-right font-semibold">POP</th>
                <th className="px-2 py-2.5 text-right font-semibold">Spread</th>
                <th className="px-2 py-2.5 text-right font-semibold">Dist. (spot)</th>
                <th className="px-2 py-2.5 text-right font-semibold">Mouv. attendu</th>
                <th className="px-2 py-2.5 text-right font-semibold">Plage attendue</th>
                <th className="px-2 py-2.5 text-center font-semibold">Score</th>
                <th className="px-2 py-2.5 text-right font-semibold">Capital / contrat</th>
                <th className="px-2 py-2.5 text-center font-semibold">Détails</th>
              </tr>
            </thead>
            <tbody>
              {group.map(({ item, score }, idx) => {
                const sym = String(item?.ticker ?? "").toUpperCase();
                const isExpanded = expandedTickerCards[sym] === true;
                return (
                  <CremeTableRow
                    key={sym}
                    item={item}
                    sym={sym}
                    rank={idx + 1}
                    creamScore={score}
                    cfg={cfg}
                    isExpanded={isExpanded}
                    onToggleExpand={() => toggleTickerCard(sym)}
                    onOpenDetail={onOpenDetail}
                    yahooRankForIbkr={yahooRankForIbkrBySymbol.get(sym)}
                    ibkrBatchRow={ibkrBatchByTicker.get(sym) ?? null}
                    seasonality={seasonalityMap[sym] ?? null}
                    highlightedTicker={highlightedTicker}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Avatar circulaire compact pour le ticker (style maquette).
function CremeTickerAvatar({ sym, name }) {
  const palette = ["#18d1d1", "#19a7ff", "#a855f7", "#22e36f", "#ff9f1a", "#ff4d57"];
  let hash = 0;
  for (let i = 0; i < sym.length; i += 1) hash = (hash * 31 + sym.charCodeAt(i)) >>> 0;
  const color = palette[hash % palette.length];
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[10px] font-bold tracking-tight"
      style={{ color, backgroundColor: `${color}1f`, border: `1px solid ${color}55` }}
      title={name ?? sym}
    >
      {sym.slice(0, 4)}
    </span>
  );
}

// Une ligne compacte du tableau « crème de la crème » + expansion fiche complète au besoin.
function CremeTableRow({
  item,
  sym,
  rank,
  creamScore,
  cfg,
  isExpanded,
  onToggleExpand,
  onOpenDetail,
  yahooRankForIbkr,
  ibkrBatchRow,
  seasonality,
  highlightedTicker,
}) {
  const { finalDisplayMode, finalDisplayGrade } = getFinalDisplayRecommendation(item);
  const tickerMeta = getTickerDisplayMeta(item.ticker);
  const resolvedName =
    tickerMeta.name ?? item.companyName ?? item.longName ?? item.shortName ?? null;
  const isAggressive = finalDisplayMode === "AGGRESSIVE";
  const displayLeg = isAggressive ? item.aggressiveStrike : item.safeStrike;

  const priceNum = Number(item?.price);
  const strikeNum = Number(displayLeg?.strike);
  const bidNum = Number(displayLeg?.bid);
  const yieldNum =
    Number.isFinite(Number(displayLeg?.weeklyYield)) && Number(displayLeg.weeklyYield) > 0
      ? Number(displayLeg.weeklyYield)
      : Number.isFinite(Number(item.weeklyReturn)) ? Number(item.weeklyReturn) : NaN;
  const popRaw = Number(displayLeg?.popProfitEstimated ?? displayLeg?.popEstimate);
  const spreadNum = Number(displayLeg?.liquidity?.spreadPct);
  const distNum = Number(displayLeg?.distancePct ?? item.strikeDistance);
  const moveNum = Number(item.expectedMovePct);
  const lowNum = Number(item.expectedMoveLow);
  const highNum = Number(item.expectedMoveHigh);
  const capitalPerContract =
    Number.isFinite(strikeNum) && strikeNum > 0 ? strikeNum * 100 : Number(item.capitalPerContract);

  const modeLabel = finalDisplayMode === "AGGRESSIVE" ? "AGRESSIF" : finalDisplayMode === "REJECT" ? "REJECT" : "SAFE";
  const modeTone =
    finalDisplayMode === "REJECT"
      ? "border-[#ff4d57]/40 bg-[#ff4d57]/10 text-[#ff8089]"
      : isAggressive
      ? "border-[#a855f7]/40 bg-[#a855f7]/12 text-[#cba6f7]"
      : "border-[#19a7ff]/40 bg-[#19a7ff]/12 text-[#7cc7ff]";

  const spreadTone =
    !Number.isFinite(spreadNum) ? "text-[#91a8c4]" : spreadNum > 18 ? "text-[#ff4d57]" : spreadNum > 10 ? "text-[#ff9f1a]" : "text-[#22e36f]";
  const scoreTone = creamScore >= 75 ? "text-[#22e36f]" : creamScore >= 60 ? "text-[#ffd166]" : "text-[#91a8c4]";
  const scoreV2Result = computeScoreV2(item, { seasonalityEntry: seasonality ?? null });
  const scoreV2Tone =
    scoreV2Result.total >= 75
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
      : scoreV2Result.total >= 60
      ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
      : "border-violet-500/30 bg-violet-500/10 text-violet-300";
  const isDev = item.ibkrDirect?.devScanEnabled || item.indicativeShortlistSession || item.ibkrDevIncompleteSurface;
  const isHighlighted = highlightedTicker === sym;

  const numCell = (value, formatter, tone = "text-[#f4f7fb]", strong = false) =>
    Number.isFinite(value) ? (
      <span className={cn("tabular-nums", tone, strong && "font-semibold")}>{formatter(value)}</span>
    ) : (
      <span className="text-[#6f86a6]">—</span>
    );

  return (
    <>
      <tr
        data-ticker-card={sym}
        className={cn(
          "scroll-mt-24 border-b border-[rgba(110,150,190,0.10)] text-[#f4f7fb] transition-colors hover:bg-white/[0.03]",
          isExpanded && "bg-white/[0.025]",
          isHighlighted && "bg-sky-500/10"
        )}
      >
        <td className="px-2 py-2 text-left">
          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full border border-[rgba(110,150,190,0.30)] px-1 text-[11px] font-semibold text-[#cfe0f2] tabular-nums">
            {rank}
          </span>
        </td>
        <td className="px-2 py-2">
          <div className="flex items-center gap-2">
            <CremeTickerAvatar sym={sym} name={resolvedName} />
            <div className="min-w-0">
              <div className="flex items-center gap-1 font-mono text-[13px] font-bold leading-tight text-[#f4f7fb]">
                {sym}
                {tickerMeta.isFavorite && <span className="text-amber-400" title="Favori">★</span>}
                {isDev && (
                  <span className="rounded bg-amber-500/15 px-1 text-[9px] font-semibold uppercase text-amber-300" title="Données indicatives (DEV)">DEV</span>
                )}
              </div>
              <div className="max-w-[150px] truncate text-[11px] leading-tight text-[#91a8c4]">
                {resolvedName ?? <span className="italic text-[#6f86a6]">Nom indisponible</span>}
              </div>
            </div>
          </div>
        </td>
        <td className="px-2 py-2">
          <span className={cn("inline-flex items-center rounded-[5px] border px-1.5 py-0.5 text-[11px] font-semibold", modeTone)}>
            {modeLabel}{finalDisplayGrade ? ` ${finalDisplayGrade}` : ""}
          </span>
        </td>
        <td className="px-2 py-2 text-right">{numCell(priceNum, (v) => `${v.toFixed(2)} $`, "text-[#c2d3e6]")}</td>
        <td className="px-2 py-2 text-right">
          {Number.isFinite(strikeNum) ? (
            <span className="tabular-nums font-semibold text-[#f4f7fb]">{strikeNum.toFixed(0)} <span className="text-[10px] font-normal text-[#91a8c4]">PUT</span></span>
          ) : (
            <span className="text-[#6f86a6]">—</span>
          )}
        </td>
        <td className="px-2 py-2 text-right">{numCell(bidNum, (v) => `${v.toFixed(2)} $`, "text-[#f4f7fb]", true)}</td>
        <td className="px-2 py-2 text-right">{numCell(yieldNum, (v) => `${v.toFixed(2)}%`, "text-[#22e36f]", true)}</td>
        <td className="px-2 py-2 text-right">{numCell(popRaw, (v) => `${(v * 100).toFixed(0)}%`, "text-[#f4f7fb]", true)}</td>
        <td className="px-2 py-2 text-right">{numCell(spreadNum, (v) => `${v.toFixed(1)}%`, spreadTone)}</td>
        <td className="px-2 py-2 text-right">{numCell(distNum, (v) => `${v.toFixed(1)}%`, "text-[#ff4d57]")}</td>
        <td className="px-2 py-2 text-right">{numCell(moveNum, (v) => `${v.toFixed(2)}%`, "text-[#ff9f1a]")}</td>
        <td className="px-2 py-2 text-right">
          {Number.isFinite(lowNum) && Number.isFinite(highNum) ? (
            <span className="tabular-nums text-[#c2d3e6]">{lowNum.toFixed(2)} – {highNum.toFixed(2)}</span>
          ) : (
            <span className="text-[#6f86a6]">—</span>
          )}
        </td>
        <td className="px-2 py-2 text-center">
          <div className="inline-flex flex-wrap items-center justify-center gap-1">
            {numCell(creamScore, (v) => `${v}/100`, scoreTone, true)}
            <span
              className={cn(
                "rounded border px-1 py-0.5 text-[9px] font-semibold whitespace-nowrap",
                scoreV2Tone
              )}
              title="Score V2 expérimental — n'influence pas le classement"
            >
              V2 test {scoreV2Result.total}/100
            </span>
          </div>
        </td>
        <td className="px-2 py-2 text-right">{numCell(capitalPerContract, (v) => `${v.toFixed(0)} $`, "text-[#c2d3e6]")}</td>
        <td className="px-2 py-2">
          <div className="flex items-center justify-center gap-1">
            <button
              type="button"
              onClick={() => onOpenDetail(item)}
              className="rounded-[6px] border border-[rgba(110,150,190,0.30)] bg-[#0d2034] px-2.5 py-1 text-[11px] font-semibold text-[#cfe0f2] hover:border-emerald-400 hover:text-white transition-colors"
            >
              Voir
            </button>
          </div>
        </td>
      </tr>
    </>
  );
}

// Source de vérité visuelle prix / mouvement attendu / plage attendue.
// Si la candidate vient d'un scan IBKR live (optionsSource === "IBKR live")
// et porte un prix valide, on affiche le snapshot IBKR du scan : Yahoo
// (get_quote / get_expected_move) ne doit plus écraser le header de la modale.
// Sinon, on conserve le fallback Yahoo existant (Yahoo prioritaire, puis item).
function getOpportunityDisplayMarketSnapshot(item, liveData) {
  const itemPrice = Number(item?.price);
  const isIbkrLive = item?.optionsSource === "IBKR live" && Number.isFinite(itemPrice) && itemPrice > 0;

  if (isIbkrLive) {
    return {
      displayPrice: item.price,
      displayExpectedMovePct: item.expectedMovePct,
      displayExpectedMoveLow: item.expectedMoveLow,
      displayExpectedMoveHigh: item.expectedMoveHigh,
      displaySource: "IBKR",
    };
  }

  return {
    displayPrice:
      liveData?.quote?.regularMarketPrice ??
      liveData?.quote?.currentPrice ??
      item?.price,
    displayExpectedMovePct:
      liveData?.expectedMove?.expectedMovePercent ??
      item?.expectedMovePct,
    displayExpectedMoveLow:
      liveData?.expectedMove?.oneSigmaRange?.lower ??
      item?.expectedMoveLow,
    displayExpectedMoveHigh:
      liveData?.expectedMove?.oneSigmaRange?.upper ??
      item?.expectedMoveHigh,
    displaySource: "Yahoo",
  };
}

// ── Helpers UI locaux pour le résumé décision du DetailModal ──────────────
// IMPORTANT : lecture seule. Ces fonctions n'altèrent NI les données NI le
// classement. Elles reformulent uniquement des champs déjà présents dans `item`
// (mêmes seuils que getCreamQualityScore, sans le recalculer).
function getDetailActiveSpreadPct(item, mode) {
  const primary = mode === "AGGRESSIVE" ? getAggressiveSpreadPct(item) : getSafeSpreadPct(item);
  if (Number.isFinite(primary)) return primary;
  const fallback = mode === "AGGRESSIVE" ? getSafeSpreadPct(item) : getAggressiveSpreadPct(item);
  return Number.isFinite(fallback) ? fallback : null;
}

function isSafeEqualsAggressive(item) {
  const s = Number(item?.safeStrike?.strike);
  const a = Number(item?.aggressiveStrike?.strike);
  return Number.isFinite(s) && Number.isFinite(a) && s === a;
}

function getDetailShortVerdict(item, mode, grade, bucketInfo) {
  if (mode === "REJECT") return "À éviter pour l'instant.";
  const bucket = bucketInfo?.bucket;
  if (bucket === "topExecutable") {
    return mode === "AGGRESSIVE" ? "Exécutable en mode agressif." : "Exécutable en mode safe.";
  }
  if (grade === "WATCH") return "À surveiller — pas prêt à exécuter.";
  if (bucket === "favoriteWatch") return "Favori à surveiller.";
  if (bucket === "spreadRejected") return "Spread trop large pour exécuter.";
  if (bucket === "unknownReview") return "Ticker à classer avant d'agir.";
  return "À surveiller.";
}

function getDetailMainRisk(item, { spreadPct, rsi, distancePct } = {}) {
  const safeDays = getSafeEarningsDaysUntil(item);
  const hasEarnings = isEarningsBeforeExpirationForItem(item);
  if (hasEarnings) {
    if (safeDays != null && safeDays >= 0 && safeDays <= 7) {
      return `Earnings dans ${safeDays} j`;
    }
    if (safeDays == null) {
      return "Earnings avant expiration";
    }
  }
  if (Number.isFinite(Number(spreadPct)) && Number(spreadPct) > 25) {
    return `Spread large (${Number(spreadPct).toFixed(0)}%)`;
  }
  if (Number.isFinite(Number(rsi)) && Number(rsi) > 75) {
    return `RSI élevé (${Number(rsi).toFixed(0)})`;
  }
  if (Number.isFinite(Number(distancePct)) && Number(distancePct) > -5) {
    return "Strike proche du prix";
  }
  if (String(item?.trend || "") === "bearish") return "Tendance baissière";
  return null;
}

// Reformule les facteurs déjà utilisés par getCreamQualityScore (mêmes seuils),
// sans recalculer ni modifier le score réel.
function buildCreamRankExplanation(item) {
  const meta = getTickerDisplayMeta(String(item?.ticker ?? "").toUpperCase());
  const tier = meta.qualityTier;
  const safeSp = getSafeSpreadPct(item);
  const aggSp = getAggressiveSpreadPct(item);
  const spreadValues = [safeSp, aggSp].filter((v) => Number.isFinite(v));
  const sp = spreadValues.length ? Math.min(...spreadValues) : null;
  const dist = Number(item?.safeStrike?.distancePct);
  const wr = Number(item?.weeklyReturn ?? 0);
  const rsi = Number(item?.rsi);
  const safeDays = getSafeEarningsDaysUntil(item);
  const earningsDaysWindow = safeDays != null && safeDays >= 0 && safeDays <= 7;
  const hasEarnings = isEarningsBeforeExpirationForItem(item);

  const positives = [];
  const penalties = [];
  const limits = [];

  if (tier === "Core Quality") positives.push("Ticker Core Quality (qualité élevée)");
  else if (tier === "Cyclique") positives.push("Ticker cyclique (qualité correcte)");
  else if (tier === "Spéculatif favori") positives.push("Spéculatif favori");
  else if (tier === "Thématique risqué") penalties.push("Tier thématique risqué");
  else if (tier === "Inconnu à valider") penalties.push("Ticker non classé (tier inconnu)");

  if (sp != null) {
    if (sp <= 15) positives.push(`Spread serré (${sp.toFixed(0)}%)`);
    else if (sp <= 25) positives.push(`Spread acceptable (${sp.toFixed(0)}%)`);
    else if (sp <= 50) penalties.push(`Spread large (${sp.toFixed(0)}%)`);
    else penalties.push(`Spread très large (${sp.toFixed(0)}%)`);
  } else {
    limits.push("Spread indisponible");
  }

  if (Number.isFinite(dist)) {
    if (dist <= -10) positives.push(`Strike loin sous le prix (${dist.toFixed(1)}%)`);
    else if (dist <= -5) positives.push(`Strike sous le prix (${dist.toFixed(1)}%)`);
    else penalties.push(`Strike proche du prix (${dist.toFixed(1)}%)`);
  } else {
    limits.push("Distance strike indisponible");
  }

  if (wr >= 1.0) positives.push(`Rendement élevé (${wr.toFixed(2)}%)`);
  else if (wr >= 0.75) positives.push(`Bon rendement (${wr.toFixed(2)}%)`);
  else if (wr >= 0.5) positives.push(`Rendement OK (${wr.toFixed(2)}%)`);
  else penalties.push(`Rendement faible (${wr.toFixed(2)}%)`);

  if (Number.isFinite(rsi)) {
    if (rsi > 75) penalties.push(`RSI élevé (${rsi.toFixed(0)})`);
  } else {
    limits.push("RSI indisponible");
  }

  if (hasEarnings) {
    if (earningsDaysWindow) {
      penalties.push(`Earnings dans ${safeDays} j`);
    } else {
      penalties.push("Earnings avant expiration");
    }
  }
  if (isSafeEqualsAggressive(item)) limits.push("SAFE = AGRESSIF (un seul strike retenu)");
  limits.push("Le score n'intègre pas le contexte macro ni le timing intraday.");

  return { tier, positives, penalties, limits };
}

function DetailModal({ item, seasonalityEntry = null, onClose }) {
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

  const {
    displayPrice: livePrice,
    displayExpectedMovePct: liveExpectedMovePct,
    displayExpectedMoveLow: liveLow,
    displayExpectedMoveHigh: liveHigh,
  } = getOpportunityDisplayMarketSnapshot(item, liveData);

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

  // ── Synthèse décision (reprise des infos utiles de la fiche inline) ──
  // Aucune donnée inventée : tout est dérivé de `item` via les mêmes helpers que la carte inline.
  const detailCreamScore = getCreamQualityScore(item);
  const detailCreamBucket = getCreamQualityBucket(item);
  const detailCreamCfg = CREAM_BUCKET_CONFIG[detailCreamBucket?.bucket] ?? CREAM_BUCKET_CONFIG.watchOnly;
  const detailTickerMeta = getTickerDisplayMeta(item.ticker);
  const detailTierStyle = QUALITY_TIER_STYLE[detailTickerMeta.qualityTier] ?? QUALITY_TIER_STYLE["Inconnu à valider"];
  const detailYahooRank = Number.isFinite(Number(item.rank)) ? Number(item.rank) : null;
  const detailDisplayLeg = finalDisplayMode === "AGGRESSIVE" ? item.aggressiveStrike : item.safeStrike;
  const detailDisplayYield =
    detailDisplayLeg?.weeklyYield != null && Number(detailDisplayLeg.weeklyYield) > 0
      ? Number(detailDisplayLeg.weeklyYield)
      : item.weeklyReturn != null && Number(item.weeklyReturn) > 0
      ? Number(item.weeklyReturn)
      : null;
  const detailDisplayDistance = detailDisplayLeg?.distancePct ?? item.strikeDistance;
  const detailCapitalPerContract =
    Number.isFinite(Number(detailDisplayLeg?.strike)) && Number(detailDisplayLeg.strike) > 0
      ? Number(detailDisplayLeg.strike) * 100
      : Number(item.capitalPerContract);
  const detailIbkrActionability = getIbkrActionabilityStatus(item);
  const detailModeLine =
    finalDisplayMode === "REJECT"
      ? { tone: "text-rose-400", text: "REJECT" }
      : finalDisplayGrade === "WATCH"
      ? { tone: "text-amber-300", text: `${finalDisplayMode} [WATCH]` }
      : finalDisplayMode === "AGGRESSIVE"
      ? { tone: "text-emerald-300", text: `AGRESSIF${finalDisplayGrade ? ` [${finalDisplayGrade}]` : ""}` }
      : { tone: "text-emerald-400", text: `SAFE${finalDisplayGrade ? ` [${finalDisplayGrade}]` : ""}` };

  // ── Résumé décision (lecture seule, aucune donnée inventée) ──
  const detailRealExpiration = liveData?.firstExpiration || item.targetExpiration || item.expiration || "—";
  const detailStrikeRetenu = Number(detailDisplayLeg?.strike);
  const detailPremiumRetenu = Number(detailDisplayLeg?.premiumUsed ?? detailDisplayLeg?.mid);
  const detailActiveSpread = getDetailActiveSpreadPct(item, finalDisplayMode);
  const detailShortVerdict = getDetailShortVerdict(item, finalDisplayMode, finalDisplayGrade, detailCreamBucket);
  const detailMainRisk = getDetailMainRisk(item, {
    spreadPct: detailActiveSpread,
    rsi: item.rsi,
    distancePct: detailDisplayDistance,
  });
  const detailRankExplanation = buildCreamRankExplanation(item);
  const detailScoreV2 = computeScoreV2(item, { seasonalityEntry });

  return (
    <div className="fixed inset-0 z-50 bg-black/40 p-4">
      <div className="mx-auto flex h-[90vh] w-[95vw] max-w-[1600px] flex-col overflow-hidden rounded-3xl bg-slate-900 shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-700 bg-slate-900 px-6 py-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-100">
              {item.ticker} — {item.name}
            </h2>
            <p className="mt-1 text-sm text-slate-500">{item.setup}</p>
            {earningsDisplay ? (
              <p className="mt-1 text-sm text-amber-400">
                {earningsDisplay}
              </p>
            ) : relevantEarningsDate ? (
              <p className="mt-1 text-sm text-violet-400">
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
            <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-400">
              Chargement des données live...
            </div>
          )}

          {error && (
            <div className="rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-400">
              {error}
            </div>
          )}

          {/* ── HEADER CRITIQUE : synthèse décision (10 secondes) ── */}
          <div className="rounded-2xl border border-[#172637] bg-[#06101a]/80 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs uppercase tracking-wide text-slate-500">Score crème</span>
              <span className={cn("rounded px-2 py-0.5 text-sm font-bold", detailCreamCfg.tag)}>
                {detailCreamScore}/100
              </span>
              <span className={cn("rounded px-2 py-0.5 text-xs", detailCreamCfg.tag)}>
                {detailCreamCfg.label}
              </span>
              <span className={cn("rounded px-2 py-0.5 text-xs font-semibold", detailModeLine.tone)}>
                Mode : {detailModeLine.text}
              </span>
              <Badge className={cn("rounded-[4px] border px-2 py-0.5 text-[11px] font-medium", detailTierStyle.badge)}>
                {detailTickerMeta.qualityTier}
              </Badge>
              {detailYahooRank != null && (
                <Badge className="rounded-[6px] border border-[#26384b] bg-[#07111b] px-2 py-0.5 text-xs text-slate-100">
                  Choix #{detailYahooRank}
                </Badge>
              )}
              {detailYahooRank != null && (
                <Badge className="rounded-[6px] border border-[#26384b] bg-[#07111b] px-2 py-0.5 text-xs text-slate-100">
                  Rang Yahoo #{detailYahooRank}
                </Badge>
              )}
              {item.verdict && (
                <Badge className={cn("rounded-[4px] border px-2 py-0.5 text-xs", verdictStyle[item.verdict])}>
                  {item.verdict}
                </Badge>
              )}
              {item.ok && !item.ibkrDevObjectiveBlocked ? (
                <Badge className="rounded-[4px] border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-400">
                  objectif validé
                </Badge>
              ) : (
                <Badge className="rounded-[4px] border border-slate-700 bg-slate-800/50 px-2 py-0.5 text-xs text-slate-400">
                  à surveiller
                </Badge>
              )}
              {item.optionsSource === "IBKR live" && (
                <Badge className="rounded-[4px] border border-emerald-800 bg-emerald-950/40 px-2 py-0.5 text-xs text-emerald-400">
                  {formatIbkrOptionsProvenanceLabel(item.dataProvenance)}
                </Badge>
              )}
              {item.optionsSource === "IBKR live" && (
                <Badge className={cn("rounded-[4px] border px-2 py-0.5 text-xs", detailIbkrActionability.className)}>
                  {detailIbkrActionability.label}
                </Badge>
              )}
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="text-slate-300">
                <span className="font-semibold text-slate-100">Verdict :</span> {detailShortVerdict}
              </span>
              {detailMainRisk && (
                <span className="text-amber-300">
                  <span className="font-semibold">Risque principal :</span> {detailMainRisk}
                </span>
              )}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
              <Metric label="Prix actuel" value={`$${Number(livePrice || 0).toFixed(2)}`} strong />
              <Metric label="Expiration" value={detailRealExpiration} strong />
              <Metric
                label="DTE"
                value={Number.isFinite(Number(item?.dteDays)) ? `${Number(item.dteDays)} jours` : "—"}
                strong
              />
              <Metric
                label="Strike retenu"
                value={Number.isFinite(detailStrikeRetenu) ? `$${detailStrikeRetenu.toFixed(2)}` : "—"}
                strong
                tone="good"
              />
              <Metric
                label="Prime"
                value={Number.isFinite(detailPremiumRetenu) ? `$${detailPremiumRetenu.toFixed(2)}` : "—"}
                strong
              />
              <Metric
                label={`Rendement${finalDisplayMode === "AGGRESSIVE" ? " (agressif)" : ""}`}
                value={detailDisplayYield != null ? `${detailDisplayYield.toFixed(2)}%` : "—"}
                sub={detailDisplayYield != null ? "jusqu'à expiration" : null}
                strong={detailDisplayYield != null && detailDisplayYield >= 0.5}
                tone={detailDisplayYield == null ? "default" : detailDisplayYield >= 0.5 ? "good" : "bad"}
              />
              <Metric
                label="Spread"
                value={Number.isFinite(detailActiveSpread) ? `${detailActiveSpread.toFixed(0)}%` : "—"}
                tone={
                  !Number.isFinite(detailActiveSpread)
                    ? "default"
                    : detailActiveSpread <= 15
                    ? "good"
                    : detailActiveSpread <= 25
                    ? "warn"
                    : "bad"
                }
              />
              <Metric
                label="Distance strike"
                value={Number.isFinite(Number(detailDisplayDistance)) ? `${Number(detailDisplayDistance).toFixed(1)}%` : "—"}
              />
              <Metric
                label="Mouvement attendu"
                value={
                  item.earningsMode
                    ? `${Number(liveExpectedMovePct || 0).toFixed(2)}% → ${Number(adjustedMovePct || 0).toFixed(2)}%`
                    : `${Number(liveExpectedMovePct || 0).toFixed(2)}%`
                }
                tone={item.earningsMode ? "bad" : "warn"}
              />
              <Metric
                label="Plage attendue"
                value={`$${Number(liveLow || 0).toFixed(2)} – $${Number(liveHigh || 0).toFixed(2)}`}
                tone="bad"
              />
              <Metric
                label="Capital / contrat"
                value={Number.isFinite(detailCapitalPerContract) ? `$${detailCapitalPerContract.toFixed(0)}` : "—"}
              />
            </div>
          </div>

          {/* ── POURQUOI CE RANG ? (lecture seule, basé sur item) ── */}
          <div className="rounded-2xl border border-[#172637] bg-[#06101a]/60 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-slate-100">Pourquoi ce rang ?</p>
              <span className={cn("rounded px-2 py-0.5 text-sm font-bold", detailCreamCfg.tag)}>
                {detailCreamScore}/100
              </span>
              <span className={cn("rounded px-2 py-0.5 text-xs", detailCreamCfg.tag)}>
                {detailCreamBucket?.label ?? detailCreamCfg.label}
              </span>
              <Badge className={cn("rounded-[4px] border px-2 py-0.5 text-[11px] font-medium", detailTierStyle.badge)}>
                {detailTickerMeta.qualityTier}
              </Badge>
            </div>
            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">Facteurs positifs</p>
                <ul className="mt-1 space-y-1 text-sm text-slate-300">
                  {detailRankExplanation.positives.length ? (
                    detailRankExplanation.positives.map((t, i) => <li key={`pos-${i}`}>+ {t}</li>)
                  ) : (
                    <li className="text-slate-500">—</li>
                  )}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-rose-400">Pénalités</p>
                <ul className="mt-1 space-y-1 text-sm text-slate-300">
                  {detailRankExplanation.penalties.length ? (
                    detailRankExplanation.penalties.map((t, i) => <li key={`pen-${i}`}>− {t}</li>)
                  ) : (
                    <li className="text-slate-500">Aucune pénalité notable</li>
                  )}
                </ul>
              </div>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Limites du score</p>
                <ul className="mt-1 space-y-1 text-sm text-slate-400">
                  {detailRankExplanation.limits.map((t, i) => <li key={`lim-${i}`}>· {t}</li>)}
                </ul>
              </div>
            </div>
            {detailCreamBucket?.reasons?.length ? (
              <p className="mt-3 text-xs text-slate-500">
                Bucket : {detailCreamBucket.reasons.join(" · ")}
              </p>
            ) : null}
          </div>

          {/* ── SCORE V2 EXPÉRIMENTAL (lecture seule, n'influence pas le classement) ── */}
          <div className="rounded-2xl border border-violet-800/40 bg-violet-950/20 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold text-violet-200">Score V2 Wheel expérimental</p>
              <span className="rounded border border-violet-500/40 bg-violet-500/15 px-2 py-0.5 text-sm font-bold text-violet-200">
                {detailScoreV2.total}/100
              </span>
              <span className="rounded border border-slate-600 bg-slate-800/60 px-2 py-0.5 text-xs text-slate-300">
                Score actuel {detailCreamScore}/100
              </span>
            </div>
            <p className="mt-2 text-xs italic text-violet-300/80">
              N&apos;influence pas encore le classement
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {detailScoreV2.breakdown.map((block) => (
                <div
                  key={block.key}
                  className="rounded-lg border border-violet-900/40 bg-slate-950/40 px-3 py-2 text-xs"
                >
                  <p className="font-medium text-slate-300">{block.label}</p>
                  <p className="mt-1 tabular-nums font-semibold text-violet-200">
                    {block.pts}/{block.max}
                  </p>
                </div>
              ))}
            </div>
            {detailScoreV2.alerts.length > 0 ? (
              <div className="mt-3 rounded-lg border border-amber-800/40 bg-amber-950/20 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">Alertes V2</p>
                <ul className="mt-1 space-y-1 text-sm text-amber-200">
                  {detailScoreV2.alerts.map((alert, i) => (
                    <li key={`v2-alert-${i}`}>⚠ {alert}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {/* Mini carte technique 60 séances + comparaison strikes SAFE / AGRESSIF (IBKR live) */}
          <div className="grid gap-3 xl:grid-cols-[minmax(0,1.3fr)_minmax(580px,1fr)]">
            <MiniTradeLevelsChart item={item} />
            <FaceplateStrikeOpportunities item={item} />
          </div>

          {/* ── Strikes SAFE / AGRESSIF (gardés, après le résumé critique) ── */}
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
              <div className="rounded-2xl border border-dashed border-slate-600 bg-slate-900 p-4 text-sm text-slate-500">
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
              <div className="rounded-2xl border border-dashed border-slate-600 bg-slate-900 p-4 text-sm text-slate-500">
                Aucun strike agressif snapshot.
              </div>
            )}
          </div>

          {/* ── Résumé ── */}
          <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4">
            <p className="text-sm font-semibold text-slate-100">Résumé</p>
            <p className="mt-2 text-sm leading-6 text-slate-400">{item.note}</p>
            <p className="mt-2 text-sm text-slate-400">
              Borne basse snapshot :{" "}
              <span className="font-semibold text-rose-400">
                ${Number(item.expectedMoveLow || 0).toFixed(2)}
              </span>
              {" "}· cible safe snapshot :{" "}
              <span className="font-semibold">${Number(item.minPremium || 0).toFixed(2)}</span>
              {" "}· semaines cible :{" "}
              <span className="font-semibold">{item.targetWeeks ?? 1}</span>
            </p>
          </div>

          {/* ── Détails repliables (bruit déplacé) ── */}
          <details className="rounded-2xl border border-slate-700 bg-slate-800/30">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-slate-100 [&::-webkit-details-marker]:hidden">
              <span>Fiche entreprise</span>
              <span className="text-slate-500">›</span>
            </summary>
            <div className="px-4 pb-4">
              <div className="grid grid-cols-1 gap-2 text-sm text-slate-300 md:grid-cols-2">
                <p><span className="font-semibold">Nom complet :</span> {companyName}</p>
                <p><span className="font-semibold">Type :</span> {instrumentType}</p>
                <p><span className="font-semibold">Secteur :</span> {sector}</p>
                <p><span className="font-semibold">Industrie :</span> {industry}</p>
              </div>
              <p className="mt-2 text-sm leading-6 text-slate-400">{businessSummary}</p>
            </div>
          </details>

          <details className="rounded-2xl border border-slate-700 bg-slate-800/30">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-slate-100 [&::-webkit-details-marker]:hidden">
              <span>Support / Résistance &amp; niveaux techniques</span>
              <span className="text-slate-500">›</span>
            </summary>
            <div className="px-4 pb-4">
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

          <details className="mt-2">
            <summary className="flex cursor-pointer list-none items-center justify-between rounded-xl border border-slate-700 bg-slate-800/50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 [&::-webkit-details-marker]:hidden">
              <span>Support / Résistance V4</span>
              <span>›</span>
            </summary>
            <div className="mt-2">
              <SupportResistanceV4CompactPanelClean
                data={item.supportResistanceV4}
                variant="dark"
              />
            </div>
          </details>
          <details className="hidden">
            <summary className="flex cursor-pointer list-none items-center gap-3 font-semibold text-slate-100 after:ml-auto after:text-xl after:leading-none after:text-slate-500 after:content-['›'] [&::-webkit-details-marker]:hidden">
              Support/Résistance V4 — zones confirmées
            </summary>
            <div className="mt-3">
              <SupportResistanceV4Panel data={item.supportResistanceV4} />
            </div>
          </details>
            </div>
          </details>

          {/* ── Données live / debug (déplacé en repliable) ── */}
          <details className="rounded-2xl border border-slate-700 bg-slate-800/30">
            <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-semibold text-slate-100 [&::-webkit-details-marker]:hidden">
              <span>Données live / debug</span>
              <span className="text-slate-500">›</span>
            </summary>
            <div className="px-4 pb-4 text-sm text-slate-400">
              {loading
                ? "Chargement des données live..."
                : error
                ? error
                : "Données live chargées pour le modal."}
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}

function formatCapitalShortfallReason(reason) {
  const map = {
    caps_too_strict: "Caps de risque trop stricts pour ajouter un contrat sans dépasser la limite.",
    contract_size_too_large: "Capital restant insuffisant pour le prochain contrat admissible.",
    high_beta_cap_reached: "Cap high beta atteint — aucun candidat restant ne passe ce filtre.",
    max_positions_limit: "Limite maximale de positions atteinte.",
    no_clean_incremental_candidate: "Les candidats restants dégradent trop la diversification ou le profil de risque.",
    not_enough_candidates: "Pas assez de candidats admissibles pour remplir davantage le capital.",
    min_yield_or_execution_filter: "Filtres de rendement ou d'exécution trop stricts pour les candidats restants.",
    sector_cap_reached: "Cap secteur atteint pour les candidats restants.",
    theme_cap_reached: "Cap thème atteint pour les candidats restants.",
    ticker_cap_reached: "Cap ticker atteint — contrats max déjà déployés sur ce sous-jacent.",
  };
  return map[reason] ?? `Raison non déterminée (${reason ?? "?"}).`;
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

// ─── Inspector Combinaisons capital (read-only, no engine impact) ───────────

const _INSP_BUCKETS = {
  SAFE: {
    label: "SAFE",
    allowedModes: new Set(["SAFE"]),
    allowedGrades: new Set(["A", "B"]),
    minYield: 0.45,
    maxYield: 0.80,
    maxSpread: 15,
    minDistancePct: null,
    color: "green",
    // filterCandidate mirrors (moteur conservatif)
    filterAvoid: true,
    filterSpeculativePopMin: 88,
    filterSpeculativeSpreadMax: 15,
    filterSpeculativeYieldMin: null,
    filterSpeculativeRequireNoEarnings: true,
    filterPremiumTrapPenaltyMin: null,
    filterPremiumTrapPopMin: null,
    minExecutionScore: 0,
  },
  BALANCED: {
    label: "BALANCED",
    allowedModes: new Set(["SAFE", "AGGRESSIVE"]),
    allowedGrades: new Set(["A", "B"]),
    minYield: 0.70,
    maxYield: 1.05,
    maxSpread: 20,
    minDistancePct: null,
    color: "sky",
    // filterCandidate mirrors (moteur équilibré)
    filterAvoid: true,
    filterSpeculativePopMin: 82,
    filterSpeculativeSpreadMax: 20,
    filterSpeculativeYieldMin: 0.75,
    filterSpeculativeRequireNoEarnings: false,
    filterPremiumTrapPenaltyMin: null,
    filterPremiumTrapPopMin: null,
    minExecutionScore: 0,
  },
  AGGRESSIVE: {
    label: "AGGRESSIVE",
    allowedModes: new Set(["AGGRESSIVE"]),
    allowedGrades: new Set(["A", "B"]),
    minYield: 0.95,
    maxYield: null,
    maxSpread: 25,
    minDistancePct: -5,
    color: "orange",
    // filterCandidate mirrors (moteur agressif)
    filterAvoid: true,
    filterSpeculativePopMin: null,
    filterSpeculativeSpreadMax: 20,
    filterSpeculativeYieldMin: null,
    filterSpeculativeRequireNoEarnings: false,
    filterPremiumTrapPenaltyMin: 0.40,
    filterPremiumTrapPopMin: 82,
    minExecutionScore: CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE,
  },
};
const _INSP_BUCKET_KEYS = ["SAFE", "BALANCED", "AGGRESSIVE"];

function _inspFindCombo(combos, bucketKey) {
  const aliases = {
    SAFE: ["SAFE", "Conservateur"],
    BALANCED: ["BALANCED", "Équilibré", "Équilibré"],
    AGGRESSIVE: ["AGGRESSIVE", "Agressif"],
  };
  const keys = aliases[bucketKey] ?? [bucketKey];
  return combos.find((c) => keys.includes(c?.label)) ?? null;
}

function _inspYesNo(flag) {
  return flag ? "oui" : "non";
}

function _inspCandidateDiag(candidate, bucketKey, combos, capital, ibkrRejectedSymbols = new Set()) {
  const cfg = _INSP_BUCKETS[bucketKey];
  const combo = _inspFindCombo(combos, bucketKey);
  const ticker = String(candidate?.ticker || "").trim().toUpperCase();
  const pick = combo?.picks?.find((p) => String(p?.ticker || "").toUpperCase() === ticker) ?? null;
  const rec = getFinalDisplayRecommendation(candidate);
  const globalMode = String(candidate.finalDisplayMode || rec.finalDisplayMode || "").toUpperCase();
  const safeLeg = candidate.safeStrike ?? null;
  const aggLeg = candidate.aggressiveStrike ?? null;
  const meta = getTickerDisplayMeta(ticker);
  const isCryptoBlocked = meta.isCryptoBlocked && !meta.isCryptoAllowed;
  const inPicks = pick != null;
  const ibkrRejected = ibkrRejectedSymbols.has(ticker);

  // Jambe et grade spécifiques au bucket (indépendants du mode global)
  let bucketLeg;
  let bucketGrade;
  if (bucketKey === "SAFE") {
    bucketLeg = safeLeg;
    bucketGrade = String(candidate?.safeGrade ?? "").toUpperCase() || null;
  } else if (bucketKey === "AGGRESSIVE") {
    bucketLeg = aggLeg;
    const _diagAggYld = getLegYieldPct(aggLeg, candidate);
    const _diagAggSp = getLegSpreadPct(aggLeg);
    const _diagAggPop = aggLeg?.popProfitEstimated ?? aggLeg?.popEstimate;
    const _diagAggDerived = gradeLeg({ spreadPct: _diagAggSp, weeklyYieldPct: _diagAggYld, popDecimal: _diagAggPop });
    bucketGrade = String(
      getAggressivePriorityGrade({
        spreadPct: _diagAggSp,
        weeklyYieldPct: _diagAggYld,
        popDecimal: _diagAggPop,
        distancePct: getLegDistancePct(aggLeg),
      }) ??
      (_diagAggDerived !== "REJECT" ? _diagAggDerived : null) ??
      candidate?.aggressiveGrade ?? ""
    ).toUpperCase() || null;
  } else {
    // BALANCED : miroir jambe du moteur — bande choix jambe [0.75, 1.05), MID=0.875 ; filtres yield pool 0.70–1.05% ; V3 = caps dynamiques runtime
    const safeY = getLegYieldPct(safeLeg, candidate);
    const aggY = getLegYieldPct(aggLeg, candidate);
    const safeInRange = safeLeg != null && safeY != null && safeY >= 0.75 && safeY < 1.05;
    const aggInRange = aggLeg != null && aggY != null && aggY >= 0.75 && aggY < 1.05;
    const MID = 0.875;
    if (safeInRange && aggInRange) {
      if (Math.abs(safeY - MID) <= Math.abs(aggY - MID)) {
        bucketLeg = safeLeg; bucketGrade = String(candidate?.safeGrade ?? "").toUpperCase() || null;
      } else {
        bucketLeg = aggLeg; bucketGrade = String(candidate?.aggressiveGrade ?? "").toUpperCase() || null;
      }
    } else if (safeInRange) {
      bucketLeg = safeLeg; bucketGrade = String(candidate?.safeGrade ?? "").toUpperCase() || null;
    } else if (aggInRange) {
      bucketLeg = aggLeg; {
        const _bdY = getLegYieldPct(aggLeg, candidate), _bdS = getLegSpreadPct(aggLeg), _bdP = aggLeg?.popProfitEstimated ?? aggLeg?.popEstimate;
        const _bdD = gradeLeg({ spreadPct: _bdS, weeklyYieldPct: _bdY, popDecimal: _bdP });
        bucketGrade = String(getAggressivePriorityGrade({ spreadPct: _bdS, weeklyYieldPct: _bdY, popDecimal: _bdP, distancePct: getLegDistancePct(aggLeg) }) ?? (_bdD !== "REJECT" ? _bdD : null) ?? candidate?.aggressiveGrade ?? "").toUpperCase() || null;
      }
    } else if (aggLeg != null) {
      bucketLeg = aggLeg; {
        const _bdY = getLegYieldPct(aggLeg, candidate), _bdS = getLegSpreadPct(aggLeg), _bdP = aggLeg?.popProfitEstimated ?? aggLeg?.popEstimate;
        const _bdD = gradeLeg({ spreadPct: _bdS, weeklyYieldPct: _bdY, popDecimal: _bdP });
        bucketGrade = String(getAggressivePriorityGrade({ spreadPct: _bdS, weeklyYieldPct: _bdY, popDecimal: _bdP, distancePct: getLegDistancePct(aggLeg) }) ?? (_bdD !== "REJECT" ? _bdD : null) ?? candidate?.aggressiveGrade ?? "").toUpperCase() || null;
      }
    } else if (safeLeg != null) {
      bucketLeg = safeLeg; bucketGrade = String(candidate?.safeGrade ?? "").toUpperCase() || null;
    }
  }

  const premium = getLegPremiumValue(bucketLeg);
  const spread = getLegSpreadPct(bucketLeg);
  const yieldPct = getLegYieldPct(bucketLeg, candidate);
  const distance = getLegDistancePct(bucketLeg);
  const pop = getLegPopPct(bucketLeg);
  const strike = Number(bucketLeg?.strike ?? NaN);
  const capitalRequired = Number.isFinite(strike) && strike > 0 ? strike * 100 : null;
  const bid = Number(bucketLeg?.bid ?? NaN);
  const ask = Number(bucketLeg?.ask ?? NaN);
  const mid = Number(bucketLeg?.mid ?? NaN);
  const bucketLegAvailable = bucketLeg != null;
  const effectiveGrade = bucketGrade ?? String(candidate.finalDisplayGrade || rec.finalDisplayGrade || "").toUpperCase();
  const comboFreeCapital = Math.max(0, Number(combo?.freeCapital ?? capital ?? 0));
  const comboCapDiag = combo?.capDiagnosticsV2 ?? null;
  const inEngineScoredPool = (comboCapDiag?.scoredPoolTickers ?? []).some(
    (tk) => String(tk || "").trim().toUpperCase() === ticker,
  );
  const greedyPoolDiag =
    comboCapDiag?.scoredPoolNotSelected?.find(
      (row) => String(row?.ticker || "").trim().toUpperCase() === ticker,
    ) ?? null;
  const residualGreedyRow =
    comboCapDiag?.nextBestResiduals?.find(
      (row) => String(row?.ticker || "").trim().toUpperCase() === ticker,
    ) ?? null;
  const blockedByStaticGrade = bucketLegAvailable && !["A", "B"].includes(effectiveGrade);
  const blockedByStaticSpread = bucketLegAvailable && spread != null && spread > cfg.maxSpread;
  const blockedByStaticYield =
    bucketLegAvailable &&
    yieldPct != null &&
    (yieldPct < cfg.minYield || (cfg.maxYield != null && yieldPct >= cfg.maxYield));
  const blockedByStaticCapital =
    capitalRequired != null && capital > 0 && capitalRequired > capital;
  const blockedByUnknown = meta.qualityTier === "Inconnu à valider";
  const passedStaticFilters =
    bucketLegAvailable &&
    !isCryptoBlocked &&
    !blockedByStaticGrade &&
    !blockedByStaticSpread &&
    !blockedByStaticYield &&
    !blockedByStaticCapital &&
    !blockedByUnknown;

  // ── Quality overlay (bucket-specific, miroir de computeTickerQualityOverlay) ─
  const bucketOv = bucketLegAvailable
    ? computeTickerQualityOverlay({
        ticker,
        spreadPct: spread,
        weeklyReturn: yieldPct,
        _popForCombo: pop,
        earningsDaysUntil: candidate?.earningsDaysUntil ?? null,
        hasEarningsBeforeExpiration:
          candidate?.hasEarningsBeforeExpiration ??
          candidate?.hasUpcomingEarningsBeforeExpiration ??
          false,
        hasUpcomingEarningsBeforeExpiration: candidate?.hasUpcomingEarningsBeforeExpiration ?? false,
      })
    : null;
  const qualityTierBucket = bucketOv?.qualityTier ?? null;
  const premiumTrapPenaltyBucket = bucketOv?.premiumTrapPenalty ?? 0;

  // ── filterCandidate mirrors (moteur) ─────────────────────────────────────
  const blockedByAvoid =
    passedStaticFilters && (cfg.filterAvoid ?? false) && qualityTierBucket === "avoid";
  const blockedByPremiumTrap =
    passedStaticFilters && !blockedByAvoid &&
    cfg.filterPremiumTrapPenaltyMin != null &&
    premiumTrapPenaltyBucket >= cfg.filterPremiumTrapPenaltyMin &&
    (pop == null || pop < (cfg.filterPremiumTrapPopMin ?? 82));
  const blockedBySpeculative =
    passedStaticFilters && !blockedByAvoid && !blockedByPremiumTrap &&
    qualityTierBucket === "speculative" && (() => {
      if (cfg.filterSpeculativePopMin != null && (pop == null || pop < cfg.filterSpeculativePopMin)) return true;
      if (cfg.filterSpeculativeSpreadMax != null && spread != null && spread > cfg.filterSpeculativeSpreadMax) return true;
      if (cfg.filterSpeculativeYieldMin != null && (yieldPct == null || yieldPct < cfg.filterSpeculativeYieldMin)) return true;
      if (cfg.filterSpeculativeRequireNoEarnings) {
        const hasEarnings =
          candidate?.hasEarningsBeforeExpiration ||
          candidate?.hasUpcomingEarningsBeforeExpiration ||
          (candidate?.earningsDaysUntil != null && candidate.earningsDaysUntil <= 7);
        if (hasEarnings) return true;
      }
      return false;
    })();
  const blockedByExecutionScore =
    passedStaticFilters && !blockedByAvoid && !blockedByPremiumTrap && !blockedBySpeculative &&
    (cfg.minExecutionScore ?? 0) > 0 &&
    (() => {
      const bucketExecutionScore = getCandidateExecutionScore(candidate, bucketLeg);
      return (
        bucketExecutionScore != null &&
        Number.isFinite(bucketExecutionScore) &&
        bucketExecutionScore < cfg.minExecutionScore
      );
    })();
  const blockedByDistancePct =
    passedStaticFilters && !blockedByAvoid && !blockedByPremiumTrap && !blockedBySpeculative &&
    !blockedByExecutionScore &&
    cfg.minDistancePct != null &&
    distance != null &&
    distance > cfg.minDistancePct;

  const passedAllFilters =
    passedStaticFilters &&
    !blockedByAvoid && !blockedByPremiumTrap && !blockedBySpeculative &&
    !blockedByExecutionScore && !blockedByDistancePct;

  const blockedByCapitalEnvelope =
    !inPicks &&
    passedAllFilters &&
    capitalRequired != null &&
    capitalRequired > comboFreeCapital;
  const possibleDynamicBlock =
    !inPicks &&
    passedAllFilters &&
    !blockedByCapitalEnvelope;

  let diagCategory = "non_selected";
  let statusProbable;
  let raisonProbable;
  if (inPicks) {
    diagCategory = "selected";
    statusProbable = "sélectionné";
    raisonProbable = "—";
  } else if (ibkrRejected) {
    diagCategory = "ibkr_rejected";
    statusProbable = "hors basePool — IBKR rejeté";
    raisonProbable = "exclu avant basePool — symbole rejeté par IBKR live";
  } else if (isCryptoBlocked) {
    diagCategory = "blocked_static";
    statusProbable = "rejeté avant scoredPool";
    raisonProbable = "bloqué avant scoredPool — crypto/commodity exclu";
  } else if (!bucketLegAvailable) {
    diagCategory = "no_bucket_leg";
    statusProbable = "aucune jambe bucket";
    raisonProbable = "pas de jambe bucket";
  } else if (blockedByStaticGrade) {
    diagCategory = "blocked_static";
    statusProbable = "rejeté avant scoredPool";
    raisonProbable = "bloqué avant scoredPool — grade non A/B";
  } else if (blockedByStaticSpread) {
    diagCategory = "blocked_static";
    statusProbable = "rejeté avant scoredPool";
    raisonProbable = "bloqué avant scoredPool — spread trop large";
  } else if (blockedByStaticYield) {
    diagCategory = "blocked_static";
    statusProbable = "rejeté avant scoredPool";
    raisonProbable = "bloqué avant scoredPool — yield hors bande";
  } else if (blockedByStaticCapital) {
    diagCategory = "blocked_static";
    statusProbable = "rejeté avant scoredPool";
    raisonProbable = "bloqué avant scoredPool — capital déployable insuffisant";
  } else if (blockedByUnknown) {
    diagCategory = "blocked_static";
    statusProbable = "rejeté avant scoredPool";
    raisonProbable = "bloqué avant scoredPool — inconnu à valider";
  } else if (blockedByAvoid) {
    diagCategory = "filtered_quality";
    statusProbable = "rejeté par filterCandidate";
    raisonProbable = `qualityTier=avoid (score ${bucketOv?.qualityScore?.toFixed(2) ?? "n/d"}) — exclu par filtre qualité`;
  } else if (blockedByPremiumTrap) {
    diagCategory = "filtered_quality";
    statusProbable = "rejeté par filterCandidate";
    raisonProbable = `premium trap (pénalité=${premiumTrapPenaltyBucket.toFixed(2)}) sans POP ≥ ${cfg.filterPremiumTrapPopMin ?? 82}%`;
  } else if (blockedBySpeculative) {
    const specReason = (() => {
      if (cfg.filterSpeculativePopMin != null && (pop == null || pop < cfg.filterSpeculativePopMin))
        return `POP ${pop != null ? pop.toFixed(0) + "%" : "manquant"} < ${cfg.filterSpeculativePopMin}%`;
      if (cfg.filterSpeculativeSpreadMax != null && spread != null && spread > cfg.filterSpeculativeSpreadMax)
        return `spread ${spread.toFixed(1)}% > ${cfg.filterSpeculativeSpreadMax}%`;
      if (cfg.filterSpeculativeYieldMin != null && (yieldPct == null || yieldPct < cfg.filterSpeculativeYieldMin))
        return `yield ${yieldPct != null ? yieldPct.toFixed(2) + "%" : "n/d"} < ${cfg.filterSpeculativeYieldMin}%`;
      return "earnings avant expiration";
    })();
    diagCategory = "filtered_quality";
    statusProbable = "rejeté par filterCandidate";
    raisonProbable = `speculative — ${specReason}`;
  } else if (blockedByExecutionScore) {
    diagCategory = "filtered_dynamic";
    statusProbable = "rejeté par filterCandidate";
    const bucketExecutionScore = getCandidateExecutionScore(candidate, bucketLeg);
    raisonProbable = `executionScore ${bucketExecutionScore?.toFixed(2) ?? "n/d"} < min ${cfg.minExecutionScore}`;
  } else if (blockedByDistancePct) {
    diagCategory = "filtered_dynamic";
    statusProbable = "rejeté par filterCandidate";
    raisonProbable = `distance ${distance?.toFixed(1) ?? "n/d"}% > min ${cfg.minDistancePct}% (OTM insuffisant)`;
  } else if (blockedByCapitalEnvelope) {
    diagCategory = "capital_envelope";
    statusProbable = "admissible, trop cher en fin de combo";
    raisonProbable = `capital restant ${comboFreeCapital.toFixed(0)}$ insuffisant pour ${capitalRequired?.toFixed(0) ?? "?"}$`;
  } else if (inEngineScoredPool && greedyPoolDiag?.rejectionReason) {
    diagCategory = "non_selected";
    const blocker = greedyPoolDiag.rejectionReason;
    if (blocker === "not_selected_greedy_lower_marginalScore") {
      statusProbable = "dans scoredPool — non retenu greedy";
      raisonProbable = "présent dans scoredPool — non retenu : marginalScore inférieur au meilleur candidat de la passe";
    } else {
      statusProbable = `dans scoredPool — non retenu : ${blocker}`;
      raisonProbable = `présent dans scoredPool — non retenu : ${blocker} (${formatCapBlockerReason(blocker)})`;
    }
  } else if (inEngineScoredPool || possibleDynamicBlock) {
    diagCategory = "non_selected";
    statusProbable = "dans scoredPool — non retenu greedy";
    raisonProbable = residualGreedyRow?.primaryBlocker
      ? `présent dans scoredPool — non retenu : ${residualGreedyRow.primaryBlocker} (${formatCapBlockerReason(residualGreedyRow.primaryBlocker)})`
      : "présent dans scoredPool — non sélectionné : caps diversification, ordre de tri, ou capital restant";
  } else {
    diagCategory = "non_selected";
    statusProbable = "dans scoredPool — non retenu greedy";
    raisonProbable = "présent dans scoredPool — non sélectionné : caps diversification, ordre de tri, ou capital restant";
  }

  const executionBreakdown =
    blockedByExecutionScore && bucketLeg
      ? (() => {
          const bd = getLegExecutionBreakdown(bucketLeg);
          if (!bd) return null;
          return {
            executionScore: bd.executionScore,
            minExecutionScore: cfg.minExecutionScore,
            spreadScore: bd.spreadScore,
            volumeScore: bd.volumeScore,
            openInterestScore: bd.openInterestScore,
            spreadPct: bd.spreadPct,
            volume: bd.volume,
            openInterest: bd.openInterest,
          };
        })()
      : null;

  return {
    ticker, bucket: bucketKey, inScanData: true, inPicks, diagCategory,
    mode: globalMode, grade: effectiveGrade,
    safeLegAvailable: safeLeg != null,
    aggLegAvailable: aggLeg != null,
    bucketLegAvailable,
    strike: Number.isFinite(strike) ? strike : null,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    mid: Number.isFinite(mid) ? mid : null,
    spread, yieldPct, distance, pop,
    capitalRequired, premiumUnit: premium,
    premiumTotal: inPicks ? pick.premiumCollected : null,
    scoreCombo: inPicks ? pick.selectionScore : null,
    comboFreeCapital,
    ibkrRejected,
    passedStaticFilters,
    passedAllFilters,
    qualityTierBucket,
    premiumTrapPenaltyBucket,
    blockedByStaticGrade,
    blockedByStaticSpread,
    blockedByStaticYield,
    blockedByStaticCapital,
    blockedByAvoid,
    blockedByPremiumTrap,
    blockedBySpeculative,
    blockedByExecutionScore,
    executionBreakdown,
    blockedByDistancePct,
    blockedByCapitalEnvelope,
    possibleDynamicBlock,
    inEngineScoredPool,
    greedyPoolDiag,
    statusProbable, raisonProbable, pick,
  };
}

function _inspBucketSummary(bucketKey, combos, candidates, capital, ibkrRejectedSymbols = new Set()) {
  const combo = _inspFindCombo(combos, bucketKey);
  const picks = combo?.picks ?? [];
  const diags = candidates.map((c) => _inspCandidateDiag(c, bucketKey, combos, capital, ibkrRejectedSymbols));
  const selected = diags.filter((d) => d.inPicks);
  const affiliated = diags.filter((d) => d.bucketLegAvailable);
  const eligibleNotSelected = diags.filter(
    (d) => d.diagCategory === "non_selected" || d.diagCategory === "capital_envelope"
  );
  const rejectedByBucketFilter = diags.filter(
    (d) =>
      d.diagCategory === "blocked_static" ||
      d.diagCategory === "filtered_quality" ||
      d.diagCategory === "filtered_dynamic" ||
      d.diagCategory === "ibkr_rejected"
  );
  const noBucketLeg = diags.filter((d) => d.diagCategory === "no_bucket_leg");
  return {
    positions: picks.length,
    totalCapital: combo?.totalCapital ?? 0,
    freeCapital: combo?.freeCapital ?? 0,
    totalScanCards: candidates.length,
    selected,
    affiliated,
    eligibleNotSelected,
    rejectedByBucketFilter,
    noBucketLeg,
  };
}

function _inspStatusBadge(status) {
  if (status === "sélectionné") return "rounded-full border border-emerald-800 bg-emerald-950/50 px-2 py-0.5 text-xs font-medium text-emerald-300";
  if (status === "dans scoredPool — non retenu greedy") return "rounded-full border border-sky-800 bg-sky-950/50 px-2 py-0.5 text-xs font-medium text-sky-300";
  if (status === "admissible statique non sélectionné") return "rounded-full border border-sky-800 bg-sky-950/50 px-2 py-0.5 text-xs font-medium text-sky-300";
  if (status === "admissible, trop cher en fin de combo") return "rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300";
  if (status === "admissible statique, trop cher") return "rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-300";
  if (status === "rejeté avant scoredPool") return "rounded-full border border-amber-800 bg-amber-950/40 px-2 py-0.5 text-xs font-medium text-amber-300";
  if (status === "rejeté par filterCandidate") return "rounded-full border border-orange-800 bg-orange-950/40 px-2 py-0.5 text-xs font-medium text-orange-300";
  if (status === "hors basePool — IBKR rejeté") return "rounded-full border border-rose-800 bg-rose-950/40 px-2 py-0.5 text-xs font-medium text-rose-300";
  if (status === "aucune jambe bucket") return "rounded-full bg-slate-800 px-2 py-0.5 text-xs font-medium text-slate-500";
  return "rounded-full border border-rose-800 bg-rose-950/40 px-2 py-0.5 text-xs font-medium text-rose-300";
}

const _inspFmt = (v, suffix = "", digits = 2) =>
  v != null && Number.isFinite(Number(v)) ? `${Number(v).toFixed(digits)}${suffix}` : "n/d";

function _inspLineStatus(diag) {
  if (diag.inPicks) return "sélectionné";
  if (diag.diagCategory === "non_selected") {
    if (diag.greedyPoolDiag?.rejectionReason && diag.greedyPoolDiag.rejectionReason !== "not_selected_greedy_lower_marginalScore") {
      return `dans scoredPool — non retenu : ${diag.greedyPoolDiag.rejectionReason}`;
    }
    return "dans scoredPool — non retenu greedy";
  }
  if (diag.diagCategory === "capital_envelope") return "admissible, trop cher en fin de combo";
  if (diag.diagCategory === "no_bucket_leg") return "sans jambe bucket valide";
  if (diag.diagCategory === "ibkr_rejected") return "hors basePool — IBKR rejeté";
  if (diag.diagCategory === "filtered_quality") return `rejeté filterCandidate — ${diag.raisonProbable}`;
  if (diag.diagCategory === "filtered_dynamic") return `rejeté filterCandidate — ${diag.raisonProbable}`;
  if (diag.diagCategory === "blocked_static") return "rejeté avant scoredPool";
  return `rejeté : ${diag.raisonProbable}`;
}

function _inspLineStatusCls(diag) {
  if (diag.inPicks) return "text-emerald-400 font-semibold";
  if (diag.diagCategory === "non_selected") return "text-sky-300";
  if (diag.diagCategory === "capital_envelope") return "text-slate-300";
  if (diag.diagCategory === "no_bucket_leg") return "text-slate-400";
  if (diag.diagCategory === "ibkr_rejected") return "text-rose-400";
  if (diag.diagCategory === "filtered_quality" || diag.diagCategory === "filtered_dynamic") return "text-orange-400";
  return "text-amber-400";
}

function BucketTickerLine({ diag }) {
  const capStr = diag.capitalRequired != null ? `${diag.capitalRequired.toFixed(0)}$` : "n/d";
  const greedyReason =
    diag.greedyPoolDiag?.rejectionReason &&
    diag.greedyPoolDiag.rejectionReason !== "not_selected_greedy_lower_marginalScore"
      ? ` · blocage greedy: ${diag.greedyPoolDiag.rejectionReason}`
      : "";
  const execRejectHint =
    diag.blockedByExecutionScore && diag.executionBreakdown
      ? ` · executionScore ${Number(diag.executionBreakdown.executionScore).toFixed(2)} < min AGGRESSIVE ${Number(diag.executionBreakdown.minExecutionScore).toFixed(2)}`
      : "";
  return (
    <div className="text-xs text-slate-300 py-px leading-snug">
      <span className="font-semibold text-slate-100">{diag.ticker}</span>
      {" — "}{diag.bucket} {diag.grade || "n/d"}
      {" — "}yield {_inspFmt(diag.yieldPct, "%")}
      {" — "}spread {_inspFmt(diag.spread, "%", 1)}
      {" — "}dist {_inspFmt(diag.distance, "%", 1)}
      {" — "}POP {_inspFmt(diag.pop, "%", 0)}
      {" — "}capital {capStr}
      {" — "}<span className={_inspLineStatusCls(diag)}>{_inspLineStatus(diag)}</span>
      {execRejectHint ? <span className="text-amber-400">{execRejectHint}</span> : null}
      {greedyReason ? <span className="text-slate-500">{greedyReason}</span> : null}
    </div>
  );
}

function BucketSection({ title, items, limit = 15 }) {
  const visible = items.slice(0, limit);
  const overflow = items.length - visible.length;
  return (
    <div className="mt-1.5">
      <p className="text-xs font-semibold text-slate-300">{title} : {items.length}</p>
      {visible.length > 0 && (
        <div className="mt-0.5 pl-2 border-l-2 border-slate-700 space-y-0">
          {visible.map((d) => <BucketTickerLine key={d.ticker} diag={d} />)}
          {overflow > 0 && (
            <p className="text-xs text-slate-400 italic">+ {overflow} autres dans Export JSON</p>
          )}
        </div>
      )}
    </div>
  );
}

function CapitalCombosInspector({
  combos,
  candidates,
  capital,
  maxCapitalPct = 100,
  maxPositions = 10,
  ibkrRejectedSymbols = new Set(),
}) {
  const [open, setOpen] = useState(false);
  const [tickerSearch, setTickerSearch] = useState("");

  const searchedTicker = String(tickerSearch || "").trim().toUpperCase();
  const usableCapital = capital * (maxCapitalPct / 100);

  const summaries = useMemo(
    () => Object.fromEntries(_INSP_BUCKET_KEYS.map((b) => [b, _inspBucketSummary(b, combos, candidates, usableCapital, ibkrRejectedSymbols)])),
    [combos, candidates, usableCapital, ibkrRejectedSymbols]
  );

  const diagnostics = useMemo(() => {
    if (!searchedTicker) return null;
    const cand = candidates.find((c) => String(c?.ticker || "").toUpperCase() === searchedTicker);
    if (!cand) {
      return _INSP_BUCKET_KEYS.map((b) => ({
        ticker: searchedTicker, bucket: b,
        inScanData: false, inPicks: false,
        diagCategory: "insufficient_data",
        passedStaticFilters: false,
        passedAllFilters: false,
        blockedByStaticGrade: false,
        blockedByStaticSpread: false,
        blockedByStaticYield: false,
        blockedByStaticCapital: false,
        ibkrRejected: ibkrRejectedSymbols.has(searchedTicker),
        blockedByAvoid: false,
        blockedByPremiumTrap: false,
        blockedBySpeculative: false,
        blockedByExecutionScore: false,
        blockedByDistancePct: false,
        blockedByCapitalEnvelope: false,
        possibleDynamicBlock: false,
        statusProbable: "données insuffisantes",
        raisonProbable: "données manquantes",
      }));
    }
    return _INSP_BUCKET_KEYS.map((b) => _inspCandidateDiag(cand, b, combos, usableCapital, ibkrRejectedSymbols));
  }, [searchedTicker, candidates, combos, usableCapital, ibkrRejectedSymbols]);

  function handleExportJSON() {
    /** Snapshot pour simulation locale sans rescan IBKR/Yahoo (`scripts/simulateCapitalCombosFromFixture.js`). */
    let serializedCandidates = [];
    try {
      serializedCandidates = candidates == null ? [] : JSON.parse(JSON.stringify(candidates));
    } catch (_e) {
      serializedCandidates = [];
    }

    const payload = {
      generatedAt: new Date().toISOString(),
      capital,
      maxCapitalPct,
      maxPositions,
      optimizerV2FlagsSnapshot: combos[0]?.capDiagnosticsV2?.flagsSnapshot ?? null,
      ibkrRejectedSymbolsSnapshot: [...ibkrRejectedSymbols],
      comboReplayCandidates: serializedCandidates,
      combosActuels: combos.map((c) => ({
        label: c.label,
        positions: c.positions,
        totalCapital: c.totalCapital,
        freeCapital: c.freeCapital,
        capDiagnosticsV2: c.capDiagnosticsV2 ?? null,
        picks: (c.picks ?? []).map((p) => ({
          ticker: p.ticker,
          strike: p.strike,
          capitalRequired: p.capitalRequired,
          premiumCollected: p.premiumCollected,
          selectionScore: p.selectionScore,
        })),
      })),
      inspecteurParBucket: Object.fromEntries(
        _INSP_BUCKET_KEYS.map((b) => {
          const s = summaries[b];
          const mapDiag = (d) => ({
            ticker: d.ticker,
            bucket: d.bucket,
            mode: d.mode,
            grade: d.grade,
            yieldPct: d.yieldPct,
            spread: d.spread,
            distance: d.distance,
            pop: d.pop,
            capitalRequired: d.capitalRequired,
            qualityTierBucket: d.qualityTierBucket ?? null,
            premiumTrapPenaltyBucket: d.premiumTrapPenaltyBucket ?? null,
            status: _inspLineStatus(d),
            raisonProbable: d.raisonProbable,
            ibkrRejected: d.ibkrRejected ?? false,
            passedStaticFilters: d.passedStaticFilters,
            passedAllFilters: d.passedAllFilters ?? d.passedStaticFilters,
            blockedByStaticGrade: d.blockedByStaticGrade,
            blockedByStaticSpread: d.blockedByStaticSpread,
            blockedByStaticYield: d.blockedByStaticYield,
            blockedByAvoid: d.blockedByAvoid ?? false,
            blockedByPremiumTrap: d.blockedByPremiumTrap ?? false,
            blockedBySpeculative: d.blockedBySpeculative ?? false,
            blockedByExecutionScore: d.blockedByExecutionScore ?? false,
            blockedByDistancePct: d.blockedByDistancePct ?? false,
            blockedByCapitalEnvelope: d.blockedByCapitalEnvelope,
            possibleDynamicBlock: d.possibleDynamicBlock,
            inEngineScoredPool: d.inEngineScoredPool ?? false,
            greedyPoolDiag: d.greedyPoolDiag ?? null,
          });
          return [b, {
            positions: s.positions,
            totalCapital: s.totalCapital,
            freeCapital: s.freeCapital,
            totalScanCards: s.totalScanCards,
            bucketMetrics: {
              selectedCount: s.selected.length,
              affiliatedCount: s.affiliated.length,
              eligibleNotSelectedCount: s.eligibleNotSelected.length,
              rejectedCount: s.rejectedByBucketFilter.length,
              noBucketLegCount: s.noBucketLeg.length,
            },
            selected: s.selected.map(mapDiag),
            affiliated: s.affiliated.map(mapDiag),
            eligibleNotSelected: s.eligibleNotSelected.map(mapDiag),
            rejectedByBucketFilter: s.rejectedByBucketFilter.map(mapDiag),
            noBucketLeg: s.noBucketLeg.map(mapDiag),
          }];
        })
      ),
      tickerRecherche: searchedTicker || null,
      diagnosticTicker: diagnostics,
      champsDisponiblesParTicker: candidates.slice(0, 3).map((c) => Object.keys(c ?? {})),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `combos-inspector-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const fmt = (v, suffix = "", digits = 2) =>
    v != null && Number.isFinite(Number(v)) ? `${Number(v).toFixed(digits)}${suffix}` : "n/d";

  const bucketColorCls = { SAFE: "green", BALANCED: "sky", AGGRESSIVE: "orange" };
  const bucketHeaderCls = {
    SAFE: "border-emerald-800/70 bg-emerald-950/50 text-emerald-200",
    BALANCED: "border-sky-800/70 bg-[#101a27] text-sky-200",
    AGGRESSIVE: "border-orange-800/70 bg-orange-950/40 text-orange-200",
  };

  return (
    <div className="mt-4 rounded-2xl border border-slate-700 bg-slate-900">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between rounded-2xl px-4 py-3 text-left hover:bg-slate-700/400"
      >
        <span className="flex items-center gap-2 text-sm font-semibold text-slate-300">
          <Search className="h-4 w-4 text-slate-400" />
          Inspecteur Combinaisons capital
        </span>
        <span className="text-xs text-slate-400">{open ? "▲ fermer" : "▼ ouvrir"}</span>
      </button>

      {open && (
        <div className="border-t border-slate-800 px-4 pb-4 pt-3 space-y-4">
          {/* Header actions */}
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="text"
              value={tickerSearch}
              onChange={(e) => setTickerSearch(e.target.value)}
              placeholder="Ex: TQQQ, APLD, HOOD, HAL, GM"
              className="flex-1 min-w-48 rounded-xl border border-slate-600 bg-slate-800/50 px-3 py-1.5 text-sm text-slate-100 placeholder-slate-400 outline-none focus:border-sky-400 focus:bg-slate-900"
            />
            <button
              type="button"
              onClick={handleExportJSON}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-700/400"
            >
              <Database className="h-3.5 w-3.5" />
              Export JSON
            </button>
          </div>

          {/* Ticker diagnostic */}
          {diagnostics && (
            <div>
              <p className="mb-2 text-xs font-semibold text-slate-400 uppercase tracking-wide">
                Diagnostic — {searchedTicker}
              </p>
              <div className="grid gap-3 md:grid-cols-3">
                {diagnostics.map((diag) => {
                  const cfg = _INSP_BUCKETS[diag.bucket];
                  const hdr = bucketHeaderCls[diag.bucket];
                  const comboForDiagBucket = _inspFindCombo(combos, diag.bucket);
                  const residualRow =
                    diag.inPicks
                      ? null
                      : comboForDiagBucket?.capDiagnosticsV2?.nextBestResiduals?.find(
                          (r) => String(r?.ticker || "").trim().toUpperCase() === searchedTicker,
                        ) ?? null;
                  const contribPct =
                    diag.capitalRequired != null && usableCapital > 0
                      ? ((Number(diag.capitalRequired) / usableCapital) * 100).toFixed(2)
                      : null;
                  const premiumEffUsdPerK =
                    diag.capitalRequired != null &&
                    usableCapital > 0 &&
                    Number(diag.capitalRequired) > 0 &&
                    diag.premiumUnit != null
                      ? ((Number(diag.premiumUnit) * 100) / Number(diag.capitalRequired)) * 1000
                      : null;
                  return (
                    <div key={diag.bucket} className={cn("rounded-xl border p-3 text-xs space-y-1", hdr)}>
                      <p className="font-semibold text-sm">{diag.ticker} — {diag.bucket}</p>
                      <span className={_inspStatusBadge(diag.statusProbable)}>{diag.statusProbable}</span>
                      <p className="text-xs mt-1 italic">{diag.raisonProbable}</p>
                      {diag.blockedByExecutionScore && diag.executionBreakdown && (
                        <div className="mt-1 rounded border border-amber-800 bg-amber-950/35 px-2 py-1 text-[11px] leading-snug text-amber-300">
                          <p className="font-semibold">Execution</p>
                          <p>
                            score {Number(diag.executionBreakdown.executionScore).toFixed(2)} / min{" "}
                            {Number(diag.executionBreakdown.minExecutionScore).toFixed(2)}
                          </p>
                          <p>
                            spreadScore {Number(diag.executionBreakdown.spreadScore).toFixed(2)} · volumeScore{" "}
                            {Number(diag.executionBreakdown.volumeScore).toFixed(2)} · OI score{" "}
                            {Number(diag.executionBreakdown.openInterestScore).toFixed(2)}
                          </p>
                          <p>
                            spread {Number(diag.executionBreakdown.spreadPct).toFixed(2)} % · volume{" "}
                            {diag.executionBreakdown.volume} · OI {diag.executionBreakdown.openInterest}
                          </p>
                        </div>
                      )}
                      <div className="mt-2 space-y-0.5 text-slate-300">
                        <Row label="Dans scan" val={diag.inScanData ? "oui" : "non"} />
                        <Row label="Sélectionné" val={diag.inPicks ? "oui" : "non"} />
                        {diag.inScanData && (
                          <>
                            <Row label="Mode global" val={diag.mode || "n/d"} />
                            <Row label="Grade global" val={diag.grade || "n/d"} />
                            <Row label="Jambe SAFE dispo" val={diag.safeLegAvailable != null ? (diag.safeLegAvailable ? "oui" : "non") : "n/d"} />
                            <Row label="Jambe AGG dispo" val={diag.aggLegAvailable != null ? (diag.aggLegAvailable ? "oui" : "non") : "n/d"} />
                            <Row label="Jambe bucket dispo" val={diag.bucketLegAvailable != null ? (diag.bucketLegAvailable ? "oui" : "non") : "n/d"} />
                            <Row label="Strike" val={diag.strike != null ? `${diag.strike}$` : "n/d"} />
                            <Row label="Bid" val={diag.bid != null ? `${fmt(diag.bid)}$` : "n/d"} />
                            <Row label="Ask" val={diag.ask != null ? `${fmt(diag.ask)}$` : "n/d"} />
                            <Row label="Mid" val={diag.mid != null ? `${fmt(diag.mid)}$` : "n/d"} />
                            <Row label="Spread %" val={fmt(diag.spread, "%", 1)} />
                            <Row label="Yield %" val={fmt(diag.yieldPct, "%")} />
                            <Row label="Distance %" val={fmt(diag.distance, "%", 1)} />
                            <Row label="POP estimée" val={fmt(diag.pop, "%", 0)} />
                            <Row label="Capital requis" val={diag.capitalRequired != null ? `${diag.capitalRequired.toFixed(0)}$` : "n/d"} />
                            <Row label="Capital libre bucket" val={diag.comboFreeCapital != null ? `${Number(diag.comboFreeCapital).toFixed(0)}$` : "n/d"} />
                            <Row label="Prime/contrat" val={diag.premiumUnit != null ? `${fmt(diag.premiumUnit)}$` : "n/d"} />
                            <Row label="IBKR rejeté" val={_inspYesNo(diag.ibkrRejected)} />
                            <Row label="Filtres statiques OK" val={_inspYesNo(diag.passedStaticFilters)} />
                            <Row label="Bloqué grade" val={_inspYesNo(diag.blockedByStaticGrade)} />
                            <Row label="Bloqué spread" val={_inspYesNo(diag.blockedByStaticSpread)} />
                            <Row label="Bloqué yield" val={_inspYesNo(diag.blockedByStaticYield)} />
                            <Row label="Qualité tier bucket" val={diag.qualityTierBucket ?? "n/d"} />
                            <Row label="Bloqué avoid" val={_inspYesNo(diag.blockedByAvoid)} />
                            <Row label="Bloqué premium trap" val={_inspYesNo(diag.blockedByPremiumTrap)} />
                            <Row label="Bloqué speculative" val={_inspYesNo(diag.blockedBySpeculative)} />
                            <Row label="Bloqué execScore" val={_inspYesNo(diag.blockedByExecutionScore)} />
                            <Row label="Bloqué distance" val={_inspYesNo(diag.blockedByDistancePct)} />
                            <Row label="Tous filtres OK" val={_inspYesNo(diag.passedAllFilters)} />
                            <Row label="Trop cher fin combo" val={_inspYesNo(diag.blockedByCapitalEnvelope)} />
                            <Row label="Dans scoredPool non retenu" val={_inspYesNo(diag.possibleDynamicBlock || diag.inEngineScoredPool)} />
                            {!diag.inPicks && diag.greedyPoolDiag && (
                              <>
                                <Row label="Blocage greedy exact" val={diag.greedyPoolDiag.rejectionReason ?? "n/d"} />
                                <Row label="canAfford" val={_inspYesNo(diag.greedyPoolDiag.canAfford)} />
                                <Row label="tickerCapOk" val={_inspYesNo(diag.greedyPoolDiag.tickerCapOk)} />
                                <Row label="sectorCapOk" val={_inspYesNo(diag.greedyPoolDiag.sectorCapOk)} />
                                <Row label="themeCapOk" val={_inspYesNo(diag.greedyPoolDiag.themeCapOk)} />
                                <Row label="highBetaCapOk" val={_inspYesNo(diag.greedyPoolDiag.highBetaCapOk)} />
                                <Row label="maxPositionsOk" val={_inspYesNo(diag.greedyPoolDiag.maxPositionsOk)} />
                                <Row label="Score allocateur" val={diag.greedyPoolDiag.score ?? "n/d"} />
                                <Row label="Jambe bucket (strike)" val={diag.greedyPoolDiag.selectedLeg ?? "n/d"} />
                              </>
                            )}
                            {!diag.inPicks && residualRow && (
                              <>
                                <Row
                                  label="Blocage après allocation"
                                  val={formatCapBlockerReason(residualRow.primaryBlocker)}
                                />
                                <Row
                                  label="Densité wedge (proxy)"
                                  val={residualRow.wedgeDensity != null ? residualRow.wedgeDensity.toFixed(4) : "n/d"}
                                />
                              </>
                            )}
                            {(comboForDiagBucket?.capDiagnosticsV2?.replacementHints?.length ?? 0) > 0 &&
                              !diag.inPicks && (
                                <Row
                                  label="Suggestions remplacement"
                                  val={comboForDiagBucket.capDiagnosticsV2.replacementHints
                                    .slice(0, 3)
                                    .map((h) => `${h.ticker}(${h.primaryBlocker})`)
                                    .join(", ")}
                                />
                              )}
                            {diag.inPicks && diag.pick ? (
                              <>
                                <Row
                                  label="Phase allocateur"
                                  val={diag.pick.comboAllocationPhase ?? "historique primaire"}
                                />
                                <Row
                                  label="Prime effic. ($ prime / k$ garantie)"
                                  val={premiumEffUsdPerK != null ? `$${premiumEffUsdPerK.toFixed(1)}` : "n/d"}
                                />
                                <Row
                                  label="Part capital déployable"
                                  val={contribPct != null ? `${contribPct}%` : "n/d"}
                                />
                              </>
                            ) : contribPct != null ? (
                              <Row label="Contribution théorique si ajoutée" val={`${contribPct}% du déployable`} />
                            ) : null}
                            {diag.inPicks && (
                              <>
                                <Row label="Prime totale" val={diag.premiumTotal != null ? `${Number(diag.premiumTotal).toFixed(0)}$` : "n/d"} />
                                <Row label="Score combo" val={diag.scoreCombo ?? "n/d"} />
                              </>
                            )}
                            <div className="mt-1 border-t border-slate-700 pt-1">
                              <p className="text-slate-500">
                                Critères {diag.bucket} — yield [{cfg.minYield}%{cfg.maxYield != null ? `–${cfg.maxYield}%` : "+"}]
                                · spread max {cfg.maxSpread}%
                                · modes {[...cfg.allowedModes].join("/")}
                                {(cfg.minExecutionScore ?? 0) > 0
                                  ? ` · min executionScore ${Number(cfg.minExecutionScore).toFixed(2)}`
                                  : ""}
                              </p>
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bucket summary */}
          <div>
            <p className="mb-1 text-xs font-semibold text-slate-400 uppercase tracking-wide">
              Résumé par bucket (approximatif, read-only)
            </p>
            <p className="mb-2 text-xs text-slate-400">
              Total {capital.toFixed(0)}$ · Déployable {usableCapital.toFixed(0)}$ ({maxCapitalPct}%)
            </p>
            <div className="grid gap-3 md:grid-cols-3">
              {_INSP_BUCKET_KEYS.map((b) => {
                const s = summaries[b];
                const hdr = bucketHeaderCls[b];
                const freeDeployable = Math.max(0, usableCapital - s.totalCapital);
                return (
                  <div key={b} className={cn("rounded-xl border p-3 text-xs", hdr)}>
                    <p className="font-semibold text-sm mb-0.5">{b}</p>
                    {(() => {
                      const cfg = _INSP_BUCKETS[b];
                      const isBalanced = b === "BALANCED";
                      const isAggressive = b === "AGGRESSIVE";
                      return (
                        <div className="text-[10px] text-slate-500 italic mb-1.5 space-y-0.5">
                          <p>
                            Yield {cfg.minYield}%{cfg.maxYield != null ? `–${cfg.maxYield}%` : "+"}
                            {" · "}Spread ≤{cfg.maxSpread}%
                            {" · "}Grades {[...cfg.allowedGrades ?? ["A","B"]].join("/")}
                          </p>
                          {isAggressive && (
                            <p>
                              Seuil executionScore AGGRESSIVE : {Number(CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE).toFixed(2)}
                              {" · "}yield ≥0.95%
                              {" · "}POP WATCH premium ≥85% (max 1 contrat)
                              {" · "}distance OTM ≤ -5%
                            </p>
                          )}
                          {isBalanced && (
                            <p>
                              POP speculative ≥82%
                              {" · "}Ticker cap 30%
                              {" · "}High beta cap 35%
                              {" · "}BITX max 1 contrat
                            </p>
                          )}
                        </div>
                      );
                    })()}
                    <Row label="Capital utilisé" val={`${s.totalCapital.toFixed(0)}$`} />
                    <Row label="Libre déployable" val={`${freeDeployable.toFixed(0)}$`} />
                    {(() => {
                      const comboV2 = _inspFindCombo(combos, b)?.capDiagnosticsV2;
                      if (!comboV2) return null;
                      const topBlk = (comboV2.blockerSummaryMerged ?? []).slice(0, 2);
                      return (
                        <p className="text-[10px] text-slate-500 leading-snug mt-1">
                          Moteur V2 · remplissage {(comboV2.fillEfficiencyPct ?? 0).toFixed(1)}%
                          {topBlk.length > 0 ? (
                            <>
                              {" "}· top blocages :{" "}
                              {topBlk.map((x) => `${x.reason}×${x.count}`).join(", ")}
                            </>
                          ) : ""}
                        </p>
                      );
                    })()}
                    <Row label="Total scan" val={s.totalScanCards} />
                    <div className="border-t border-slate-700 mt-2 pt-1">
                      <BucketSection title="Sélectionnés" items={s.selected} />
                      <div className="mt-1.5">
                        <p className="text-xs font-medium text-slate-400">Affiliés au bucket : {s.affiliated.length}</p>
                      </div>
                      <BucketSection title="Admissibles statiques non sélectionnés" items={s.eligibleNotSelected} />
                      <BucketSection title="Rejetés par filtre bucket" items={s.rejectedByBucketFilter} />
                      <BucketSection title="Sans jambe bucket valide" items={s.noBucketLeg} />
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Affichage approximatif read-only — filtres statiques reproduits, moteur complet non rejoué.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({ label, val }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500 shrink-0">{label}</span>
      <span className="font-medium text-slate-200 text-right">{val ?? "n/d"}</span>
    </div>
  );
}

/** Moyenne pondérée par le capital déployé sur la ligne (capitalUsed), pour POP / OTM — UI seulement. */
function weightedMetricByCapital(picks, pickMetricAccessor) {
  let sumWx = 0;
  let sumW = 0;
  for (const p of picks || []) {
    const w = Number(p?.capitalUsed ?? p?.capitalRequired ?? NaN);
    const x = Number(pickMetricAccessor(p));
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(x)) continue;
    sumWx += x * w;
    sumW += w;
  }
  return sumW > 0 ? sumWx / sumW : null;
}

// ────────────────────────────────────────────────────────────────────────────

/**
 * Modale décisionnelle ouverte au clic sur une carte résumée SAFE / BALANCED /
 * AGGRESSIVE / RISQUE. Vue compacte et premium — réutilise les picks déjà
 * calculés (aucun recalcul de montants, scores ni sélection).
 */
function ComboDetailModal({
  mode,
  combos,
  comboStyles,
  summaryFor,
  usableCapital,
  riskCombo,
  dominant,
  riskScore,
  riskLabel,
  riskColor,
  onClose,
  onTickerClick,
}) {
  const isRisk = mode === "RISK";
  const combo = isRisk ? riskCombo : combos.find((c) => c.label === mode);
  const accent = isRisk ? riskColor : (comboStyles[mode]?.accent ?? "#19a7ff");

  // Coloration des cellules selon la qualité (réutilise la même logique de couleurs que l'accordéon).
  const spreadColor = (v) => (v == null ? "#9fb3cc" : v <= 10 ? "#22e36f" : v <= 20 ? "#ff9f1a" : "#ff4d57");
  const scoreColor = (v) => (v == null ? "#9fb3cc" : v >= 65 ? "#22e36f" : v >= 45 ? "#ff9f1a" : "#ff4d57");
  const fmtUnit = (p) =>
    p.premiumUnit != null && Number.isFinite(Number(p.premiumUnit)) ? `${Number(p.premiumUnit).toFixed(2)}$` : "—";

  const s = combo ? summaryFor(combo) : null;
  const freeCapital = combo ? Math.max(0, usableCapital - combo.totalCapital) : 0;

  const Metric = ({ label, value, color }) => (
    <div className="rounded-xl border border-[rgba(110,150,190,0.20)] bg-[#0a1726] px-3 py-2">
      <p className="text-[11px] text-[#7f97b6]">{label}</p>
      <p className="mt-0.5 text-sm font-semibold tabular-nums" style={{ color: color ?? "#f4f7fb" }}>{value}</p>
    </div>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[80vh] w-[88vw] max-w-[1200px] flex-col overflow-hidden rounded-3xl border bg-[#0b1a2b] shadow-[0_30px_80px_rgba(0,0,0,0.55)]"
        style={{ borderColor: `${accent}40` }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-[rgba(110,150,190,0.20)] px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: accent }} />
              <h2 className="text-lg font-bold tracking-wide" style={{ color: accent }}>
                {isRisk ? "RISQUE" : mode}
              </h2>
              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: accent, backgroundColor: `${accent}1f` }}>
                {isRisk ? `Concentration ${riskLabel}` : `${combo?.positions ?? 0} positions`}
              </span>
            </div>
            <p className="mt-1 text-xs text-[#7f97b6]">
              {isRisk
                ? "Diagnostic de concentration — simulation la plus exposée"
                : "Simulation indépendante sur le capital complet — positions décisionnelles"}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fermer"
            className="shrink-0 rounded-xl border border-[rgba(110,150,190,0.25)] bg-[#0a1726] p-1.5 text-[#cfe0f2] transition hover:bg-[#12243a] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {isRisk ? (
          <RiskModalBody
            riskCombo={riskCombo}
            dominant={dominant}
            riskScore={riskScore}
            riskLabel={riskLabel}
            riskColor={riskColor}
            usableCapital={usableCapital}
            Metric={Metric}
          />
        ) : (
          <>
            {/* Métriques header en petits blocs */}
            <div className="grid grid-cols-2 gap-2 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6">
              <Metric label="Positions" value={combo?.positions ?? 0} />
              <Metric label="Prime totale" value={`${(s?.totalPremium ?? 0).toFixed(0)} $`} />
              <Metric label="Rendement port." value={`${(s?.portfolioReturnPct ?? 0).toFixed(2)} %`} color="#22e36f" />
              <Metric label="POP moyenne" value={s?.popWeighted != null ? `${Math.round(s.popWeighted)} %` : "n/d"} />
              <Metric label="Capital utilisé" value={`${(combo?.totalCapital ?? 0).toFixed(0)} $`} color="#cfe0f2" />
              <Metric label="Capital libre" value={`${freeCapital.toFixed(0)} $`} color="#cfe0f2" />
            </div>

            {/* Tableau compact des positions */}
            <div className="min-h-0 flex-1 overflow-auto px-5 pb-5">
              {(combo?.picks?.length ?? 0) === 0 ? (
                <div className="rounded-2xl border border-dashed border-[rgba(110,150,190,0.25)] bg-[#0a1726] p-5 text-center text-sm text-[#7f97b6]">
                  {combo?.emptyMessage ?? "Aucune position dans cette combinaison."}
                </div>
              ) : (
                <table className="w-full border-separate border-spacing-0 text-xs">
                  <thead className="sticky top-0 z-10">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-[#7f97b6]">
                      {["Ticker", "Mode / Grade", "Strike", "Prime", "Spread", "Rend.", "Dist.", "Contrats", "Capital", "Prime tot.", "POP", "Score", "Phase"].map((h, i) => (
                        <th
                          key={h}
                          className={cn("border-b border-[rgba(110,150,190,0.20)] bg-[#0b1a2b] px-2.5 py-2 font-medium", i === 0 && "rounded-tl-lg", i >= 2 && "text-right")}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {combo.picks.map((pick) => (
                      <tr key={`${combo.label}-${pick.ticker}-${pick.strike}`} className="group transition-colors hover:bg-[#12243a]/60">
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2">
                          <button
                            type="button"
                            onClick={() => onTickerClick?.(pick.ticker)}
                            title={`Aller à la carte principale ${pick.ticker}`}
                            className="font-bold text-[#f4f7fb] transition hover:text-sky-400 hover:underline"
                          >
                            {pick.ticker}
                          </button>
                        </td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2">
                          <span className="rounded bg-[#12243a] px-1.5 py-0.5 text-[11px] font-semibold text-[#cfe0f2]">
                            {pick.mode ?? "—"}{pick.grade ? ` ${pick.grade}` : ""}
                          </span>
                        </td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#e6eefb]">PUT {pick.strike}</td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#e6eefb]">{fmtUnit(pick)}</td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums" style={{ color: spreadColor(pick.spreadPct != null ? Number(pick.spreadPct) : null) }}>
                          {pick.spreadPct != null ? `${Number(pick.spreadPct).toFixed(1)}%` : "—"}
                        </td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#22e36f]">{pick.weeklyReturn.toFixed(2)}%</td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#ff6b73]">
                          {pick.distancePct != null ? `${Number(pick.distancePct).toFixed(1)}%` : "—"}
                        </td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#cfe0f2]">×{pick.contracts}</td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#e6eefb]">{pick.capitalRequired.toFixed(0)}$</td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#e6eefb]">{pick.premiumCollected.toFixed(0)}$</td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums text-[#cfe0f2]">
                          {pick.popEstimate != null && Number.isFinite(Number(pick.popEstimate)) ? `${Math.round(Number(pick.popEstimate))}%` : "—"}
                        </td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right tabular-nums font-semibold" style={{ color: scoreColor(pick.selectionScore != null ? Number(pick.selectionScore) : null) }}>
                          {pick.selectionScore ?? "—"}
                        </td>
                        <td className="border-b border-[rgba(110,150,190,0.10)] px-2.5 py-2 text-right">
                          <span className="rounded border border-[rgba(110,150,190,0.20)] bg-[#0a1726] px-1.5 py-0.5 text-[10px] text-[#7f97b6]" title="Phase d'allocation">
                            {pick.comboAllocationPhase ?? "primary_strict"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {combo && !combo.capitalTargetReached && combo.capitalShortfallReason && (
                <div className="mt-3 rounded-xl border border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs text-amber-400">
                  Capital non entièrement déployé — {formatCapitalShortfallReason(combo.capitalShortfallReason)}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Corps de la modale RISQUE — présentation visuelle de la concentration. */
function RiskModalBody({ riskCombo, dominant, riskScore, riskLabel, riskColor, usableCapital, Metric }) {
  const diversification = riskCombo?.diversificationHealthScore != null ? Math.round(riskCombo.diversificationHealthScore * 100) : null;
  const highBeta = riskCombo?.highBetaCapitalPct ?? null;
  const cryptoMiner = riskCombo?.cryptoMinerCapitalPct ?? null;
  const dominantPct = dominant ? dominant.pct : null;
  // Alertes : warnings de cluster déjà calculés + thèmes de concentration des picks.
  const alerts = [];
  (riskCombo?.clusterWarnings ?? []).forEach((w) => alerts.push(w));
  (riskCombo?.crossModeOverlap?.crossModeWarnings ?? []).forEach((w) => alerts.push(w));
  const themes = Array.from(
    new Set((riskCombo?.picks ?? []).map((p) => p.concentrationTheme).filter(Boolean))
  );

  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-5">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
        {/* Cercle de concentration */}
        <div className="flex shrink-0 flex-col items-center">
          <div
            className="flex h-28 w-28 items-center justify-center rounded-full text-2xl font-bold tabular-nums"
            style={{ color: riskColor, border: `6px solid ${riskColor}`, backgroundColor: `${riskColor}12` }}
          >
            {dominantPct != null ? `${dominantPct.toFixed(0)}%` : "—"}
          </div>
          <p className="mt-2 text-xs font-medium" style={{ color: riskColor }}>Concentration {riskLabel}</p>
        </div>
        {/* Métriques en petites cartes */}
        <div className="grid flex-1 grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label="Simulation" value={riskCombo?.label ?? "—"} />
          <Metric label="Ticker dominant" value={dominant?.ticker ?? "—"} />
          <Metric label="% du capital" value={dominantPct != null ? `${dominantPct.toFixed(0)} %` : "—"} color={riskColor} />
          <Metric label="Capital dominant" value={dominant?.capital != null ? `${dominant.capital.toFixed(0)} $` : "—"} color="#cfe0f2" />
          <Metric label="Diversification" value={diversification != null ? `${diversification}/100` : "n/d"} color={diversification != null && diversification < 50 ? "#ff9f1a" : "#cfe0f2"} />
          <Metric label="Score concentration" value={riskScore != null ? riskScore.toFixed(2) : "n/d"} color={riskColor} />
          {highBeta != null && highBeta > 0 && (
            <Metric label="High beta" value={`${highBeta.toFixed(0)} %`} color={highBeta > 40 ? "#ff4d57" : "#cfe0f2"} />
          )}
          {cryptoMiner != null && cryptoMiner > 0 && (
            <Metric label="Crypto / miner" value={`${cryptoMiner.toFixed(0)} %`} color={cryptoMiner > 35 ? "#ff4d57" : "#cfe0f2"} />
          )}
        </div>
      </div>

      {themes.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] uppercase tracking-wide text-[#7f97b6]">Thèmes&nbsp;:</span>
          {themes.map((t) => (
            <span key={t} className="rounded-full border border-[rgba(110,150,190,0.20)] bg-[#0a1726] px-2 py-0.5 text-[11px] text-[#cfe0f2]">{t}</span>
          ))}
        </div>
      )}

      {/* Liste courte des alertes */}
      <div className="mt-4">
        <p className="mb-1.5 text-[11px] uppercase tracking-wide text-[#7f97b6]">Alertes de risque</p>
        {alerts.length === 0 ? (
          <p className="rounded-xl border border-[rgba(110,150,190,0.20)] bg-[#0a1726] px-3 py-2 text-xs text-[#7f97b6]">
            Aucune alerte de concentration — profil bien diversifié.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {alerts.slice(0, 6).map((w, i) => (
              <li key={i} className="flex items-start gap-2 rounded-xl border px-3 py-2 text-xs" style={{ borderColor: `${riskColor}30`, backgroundColor: `${riskColor}0d` }}>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: riskColor }} />
                <span className="text-[#e6eefb]">{w}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function PortfolioCombos({
  combos,
  candidates = [],
  capital,
  maxCapitalPct = 100,
  maxPositions = 10,
  onTickerClick = null,
  ibkrRejectedSymbols = new Set(),
}) {
  const [snapshotStatus, setSnapshotStatus] = useState(null);
  const [snapshotMsg, setSnapshotMsg] = useState("");
  // Modale décisionnelle ouverte au clic sur une carte résumée : "SAFE" | "BALANCED" | "AGGRESSIVE" | "RISK" | null.
  const [selectedComboDetail, setSelectedComboDetail] = useState(null);
  const hasAnyPicks = combos.some((combo) => (combo?.picks?.length ?? 0) > 0);
  const usableCapital = capital * (maxCapitalPct / 100);
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

  // ── Données partagées entre les cartes résumées et les modales décisionnelles ──
  const COMBO_STYLES = {
    SAFE: { accent: "#19a7ff", label: "SAFE" },
    BALANCED: { accent: "#a855f7", label: "BALANCED" },
    AGGRESSIVE: { accent: "#22e36f", label: "AGGRESSIVE" },
  };
  const summaryFor = (combo) => {
    const totalPremium = combo.totalPremium ?? combo.picks.reduce((s, p) => s + p.premiumCollected, 0);
    const portfolioReturnPct = usableCapital > 0 ? (totalPremium / usableCapital) * 100 : 0;
    const popWeighted = weightedMetricByCapital(combo.picks, (p) => p.popEstimate);
    const capitalPct = usableCapital > 0 ? (combo.totalCapital / usableCapital) * 100 : 0;
    return { totalPremium, portfolioReturnPct, popWeighted, capitalPct };
  };
  // Carte RISQUE : concentration de la simulation la plus concentrée.
  const riskCombo = [...visibleCombos].sort(
    (a, b) => (b.concentrationRiskScore ?? 0) - (a.concentrationRiskScore ?? 0)
  )[0];
  const dominant = (() => {
    if (!riskCombo?.picks?.length) return null;
    const total = riskCombo.picks.reduce((s, p) => s + p.capitalRequired, 0);
    if (!total) return null;
    const byTicker = {};
    riskCombo.picks.forEach((p) => { byTicker[p.ticker] = (byTicker[p.ticker] || 0) + p.capitalRequired; });
    let topT = null, topV = 0;
    Object.entries(byTicker).forEach(([t, v]) => { if (v > topV) { topV = v; topT = t; } });
    return { ticker: topT, pct: (topV / total) * 100, capital: topV };
  })();
  const riskScore = riskCombo?.concentrationRiskScore ?? null;
  const riskLabel = riskScore == null ? "n/d" : riskScore > 0.65 ? "élevée" : riskScore > 0.45 ? "moyenne" : "faible";
  const riskColor = riskScore == null ? "#91a8c4" : riskScore > 0.65 ? "#ff4d57" : riskScore > 0.45 ? "#ff9f1a" : "#22e36f";

  // Fermeture de la modale au clavier (Échap).
  useEffect(() => {
    if (!selectedComboDetail) return undefined;
    const onKey = (e) => { if (e.key === "Escape") setSelectedComboDetail(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedComboDetail]);

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
      <CardTitle className="text-xl text-[#f4f7fb]">Combinaisons de capital <span className="text-sm font-normal text-[#7f97b6]">(résumé)</span></CardTitle>
      <button
        onClick={handleSaveSnapshot}
        disabled={snapshotStatus === "loading" || !hasAnyPicks}
        className="inline-flex items-center gap-1.5 rounded-xl border border-slate-600 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-slate-700/400 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <Database className="h-3.5 w-3.5" />
        {snapshotStatus === "loading" ? "Sauvegarde…" : "Sauvegarder snapshot"}
      </button>
    </div>
  );

  return (
    <Card className="rounded-[28px] border-[rgba(110,150,190,0.20)] bg-[#0b1a2b] shadow-[0_18px_60px_rgba(0,0,0,0.40)]">
      <CardHeader>
        {snapshotHeader}
        {snapshotStatus === "ok" && (
          <p className="mt-1.5 text-xs text-emerald-400">Snapshot sauvegardé dans SQLite. {snapshotMsg}</p>
        )}
        {snapshotStatus === "error" && (
          <p className="mt-1.5 text-xs text-rose-400">Erreur : {snapshotMsg}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Cartes résumées compactes — cliquables, ouvrent une modale décisionnelle */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {visibleCombos.map((combo) => {
            const st = COMBO_STYLES[combo.label] ?? COMBO_STYLES.SAFE;
            const s = summaryFor(combo);
            const clickable = combo.picks.length > 0;
            return (
              <button
                type="button"
                key={`summary-${combo.label}`}
                onClick={clickable ? () => setSelectedComboDetail(combo.label) : undefined}
                disabled={!clickable}
                aria-label={clickable ? `Voir les positions ${st.label}` : undefined}
                className={cn(
                  "group block w-full rounded-2xl border bg-[#0a1726] p-3.5 text-left shadow-[0_10px_30px_rgba(0,0,0,0.30)] transition-all duration-200",
                  clickable
                    ? "cursor-pointer hover:-translate-y-0.5 hover:bg-[#0c1c30]"
                    : "cursor-default opacity-80",
                )}
                style={{ borderColor: `${st.accent}33` }}
                onMouseEnter={clickable ? (e) => {
                  e.currentTarget.style.borderColor = `${st.accent}80`;
                  e.currentTarget.style.boxShadow = `0 14px 40px rgba(0,0,0,0.40), 0 0 0 1px ${st.accent}40`;
                } : undefined}
                onMouseLeave={clickable ? (e) => {
                  e.currentTarget.style.borderColor = `${st.accent}33`;
                  e.currentTarget.style.boxShadow = "0 10px 30px rgba(0,0,0,0.30)";
                } : undefined}
              >
                <div className="flex items-center justify-between">
                  <span className="text-sm font-bold tracking-wide" style={{ color: st.accent }}>{st.label}</span>
                  <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: st.accent, backgroundColor: `${st.accent}1f` }}>
                    {combo.positions} pos.
                  </span>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  <div>
                    <p className="text-[#7f97b6]">Prime totale</p>
                    <p className="font-semibold text-[#f4f7fb] tabular-nums">{s.totalPremium.toFixed(0)} $</p>
                  </div>
                  <div>
                    <p className="text-[#7f97b6]">Rend. moy.</p>
                    <p className="font-semibold text-[#22e36f] tabular-nums">{s.portfolioReturnPct.toFixed(2)}% / sem.</p>
                  </div>
                  <div>
                    <p className="text-[#7f97b6]">POP moy.</p>
                    <p className="font-semibold text-[#f4f7fb] tabular-nums">{s.popWeighted != null ? `${Math.round(s.popWeighted)}%` : "n/d"}</p>
                  </div>
                  <div>
                    <p className="text-[#7f97b6]">Capital utilisé</p>
                    <p className="font-semibold text-[#cfe0f2] tabular-nums">{combo.totalCapital.toFixed(0)} $ ({Math.round(s.capitalPct)}%)</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center gap-1 text-[11px] font-medium opacity-0 transition-opacity duration-200 group-hover:opacity-100" style={{ color: st.accent }}>
                  {clickable ? (
                    <>
                      <span>Voir positions</span>
                      <ChevronRight className="h-3 w-3" />
                    </>
                  ) : null}
                </div>
              </button>
            );
          })}
          {/* Carte RISQUE — cliquable */}
          <button
            type="button"
            onClick={dominant ? () => setSelectedComboDetail("RISK") : undefined}
            disabled={!dominant}
            aria-label={dominant ? "Voir le détail du risque" : undefined}
            className={cn(
              "group block w-full rounded-2xl border bg-[#0a1726] p-3.5 text-left shadow-[0_10px_30px_rgba(0,0,0,0.30)] transition-all duration-200",
              dominant ? "cursor-pointer hover:-translate-y-0.5 hover:bg-[#0c1c30]" : "cursor-default opacity-80",
            )}
            style={{ borderColor: `${riskColor}33` }}
            onMouseEnter={dominant ? (e) => {
              e.currentTarget.style.borderColor = `${riskColor}80`;
              e.currentTarget.style.boxShadow = `0 14px 40px rgba(0,0,0,0.40), 0 0 0 1px ${riskColor}40`;
            } : undefined}
            onMouseLeave={dominant ? (e) => {
              e.currentTarget.style.borderColor = `${riskColor}33`;
              e.currentTarget.style.boxShadow = "0 10px 30px rgba(0,0,0,0.30)";
            } : undefined}
          >
            <div className="flex items-center justify-between">
              <span className="text-sm font-bold tracking-wide" style={{ color: riskColor }}>RISQUE</span>
              <span className="rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color: riskColor, backgroundColor: `${riskColor}1f` }}>
                Concentration {riskLabel}
              </span>
            </div>
            <div className="mt-3 flex items-center justify-between gap-3 text-xs">
              <div className="min-w-0">
                <p className="text-[#7f97b6]">Ticker dominant</p>
                <p className="font-bold text-[#f4f7fb] truncate">{dominant?.ticker ?? "—"}</p>
                <p className="mt-1 text-[#7f97b6]">{dominant ? `${dominant.pct.toFixed(0)} % du capital` : "Aucune concentration"}</p>
              </div>
              {dominant && (
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums"
                  style={{ color: riskColor, border: `3px solid ${riskColor}`, backgroundColor: `${riskColor}12` }}
                >
                  {dominant.pct.toFixed(0)}%
                </div>
              )}
            </div>
            <div className="mt-3 flex items-center gap-1 text-[11px] font-medium opacity-0 transition-opacity duration-200 group-hover:opacity-100" style={{ color: riskColor }}>
              {dominant ? (
                <>
                  <span>Voir le risque</span>
                  <ChevronRight className="h-3 w-3" />
                </>
              ) : null}
            </div>
          </button>
        </div>

        {/* Modale décisionnelle au clic sur une carte résumée */}
        {selectedComboDetail && (
          <ComboDetailModal
            mode={selectedComboDetail}
            combos={visibleCombos}
            comboStyles={COMBO_STYLES}
            summaryFor={summaryFor}
            usableCapital={usableCapital}
            riskCombo={riskCombo}
            dominant={dominant}
            riskScore={riskScore}
            riskLabel={riskLabel}
            riskColor={riskColor}
            onClose={() => setSelectedComboDetail(null)}
            onTickerClick={onTickerClick}
          />
        )}

        {/* Détails complets accessibles à la demande — non ouverts par défaut. */}
        <details className="group rounded-2xl border border-[rgba(110,150,190,0.20)] bg-[#0b1a2b]">
          <summary className="cursor-pointer list-none px-4 py-2.5 text-sm font-semibold text-[#cfe0f2] [&::-webkit-details-marker]:hidden">
            <span className="underline-offset-2 group-open:underline">Voir détails des combinaisons</span>
            <span className="ml-2 text-xs font-normal text-[#7f97b6]">picks, diagnostics allocateur, inspecteur</span>
          </summary>
          <div className="space-y-4 px-3 pb-4">
        <div className="rounded-2xl border border-slate-700/70 bg-[#101a27]/95 px-4 py-3 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <p className="font-medium text-slate-100">
            Chaque bloc représente une simulation indépendante utilisant le capital complet. Les montants ne s&apos;additionnent pas.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            SAFE, BALANCED et AGGRESSIVE comparent trois politiques de sélection sur le même capital simulé.
          </p>
        </div>
        {visibleCombos.map((combo) => {
          const portfolioReturnPct =
            usableCapital > 0
              ? ((combo.totalPremium ?? combo.picks.reduce((s, p) => s + p.premiumCollected, 0)) / usableCapital) * 100
              : 0;
          const popWeighted = weightedMetricByCapital(combo.picks, (p) => p.popEstimate);
          const otmWeighted = weightedMetricByCapital(combo.picks, (p) => p.distancePct);
          return (
          <div key={combo.label} className="rounded-2xl border border-slate-700 p-4">
            <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-base font-semibold text-slate-100">{combo.label}</p>
                <p className="text-sm font-medium text-slate-300">
                  Simulation {combo.label} · {combo.positions} pos. · Rend. port. ~{portfolioReturnPct.toFixed(2)}%
                  {(combo.picks?.length ?? 0) > 0 ? (
                    <>
                      {popWeighted != null ? ` · POP moy. ${Math.round(popWeighted)}%` : " · POP moy. n/d"}
                      {otmWeighted != null ? ` · OTM moy. ${Math.round(otmWeighted)}%` : " · OTM moy. n/d"}
                    </>
                  ) : null}
                </p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Total {capital.toFixed(0)}$ · Déployable {usableCapital.toFixed(0)}$ ({maxCapitalPct}%) · Utilisé {combo.totalCapital.toFixed(0)}$ · <span className="font-medium text-slate-300">Libre dép. {Math.max(0, usableCapital - combo.totalCapital).toFixed(0)}$</span>
                </p>
                {combo.label === "BALANCED" && (
                  <p className="mt-0.5 text-[10px] text-sky-400/90 leading-snug">
                    <span className="font-medium text-sky-300">Core Institutional Yield (BALANCED V3)</span>
                    {" "}· yield filtre V3 ≥0,675%–1,05% · spread ≤22% · caps ticker / thème / secteur / high beta{" "}
                    <span className="whitespace-nowrap">scalés au capital</span>
                    {" "}· jusqu&apos;à 6–8 lignes · POP spéc. ≥82% · BITX max 1 contrat
                    {combo.balancedInstitutionalV3Audit?.effectiveMaxPositions != null ? (
                      <span className="ml-1 text-sky-200 font-medium">
                        · lignes max effectives {combo.balancedInstitutionalV3Audit.effectiveMaxPositions}
                      </span>
                    ) : null}
                    {!combo.capitalTargetReached && combo.capitalShortfallReason
                      ? <span className="ml-1 text-amber-400 font-medium">· Capital incomplet : {formatCapitalShortfallReason(combo.capitalShortfallReason)}</span>
                      : null}
                  </p>
                )}
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
                      combo.concentrationRiskScore > 0.65 ? "text-rose-400" :
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
                      <p key={i} className="text-xs text-rose-400">Concentration élevée : {w}</p>
                    ))}
                  </div>
                )}
                {combo.capDiagnosticsV2 && (
                  <details className="group mt-2 rounded-xl border border-slate-700 bg-slate-800/50/70 px-3 py-2 text-xs">
                    <summary className="cursor-pointer list-none font-semibold text-slate-300 [&::-webkit-details-marker]:hidden">
                      <span className="underline-offset-2 group-open:underline">Diagnostics allocateur V2</span>
                      <span className="ml-2 font-normal text-slate-500">
                        Remplissage {(combo.capDiagnosticsV2.fillEfficiencyPct ?? (usableCapital > 0 ? (combo.totalCapital / usableCapital) * 100 : 0)).toFixed(1)}%
                      </span>
                    </summary>
                    <div className="mt-2 space-y-1.5 text-slate-400">
                      {combo.label === "BALANCED" && combo.capDiagnosticsV2?.institutionalYieldV3 && (
                        <div className="rounded-lg border border-sky-800/60 bg-[#101a27]/95 px-2.5 py-2 text-[11px] leading-snug space-y-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
                          <p className="font-semibold text-sky-200">Institutionnel V3 — garde-fous actifs</p>
                          <p>
                            Caps (fraction du déployable) : ticker{" "}
                            {(combo.capDiagnosticsV2.institutionalYieldV3.capsFraction?.tickerCap * 100).toFixed(0)}%
                            {" · "}thème{" "}
                            {(combo.capDiagnosticsV2.institutionalYieldV3.capsFraction?.maxTheme * 100).toFixed(0)}%
                            {" · "}secteur{" "}
                            {(combo.capDiagnosticsV2.institutionalYieldV3.capsFraction?.maxSector * 100).toFixed(0)}%
                            {" · "}high beta{" "}
                            {(combo.capDiagnosticsV2.institutionalYieldV3.capsFraction?.maxHighBeta * 100).toFixed(0)}%
                            {" · "}max contrats / ticker {combo.capDiagnosticsV2.institutionalYieldV3.maxContractsPerTicker}
                            {" · "}clusters stricts après {combo.capDiagnosticsV2.institutionalYieldV3.minTargetPositionsBeforeStrictClusters} ligne(s)
                          </p>
                          {combo.capDiagnosticsV2.dominantFillBlocker && (
                            <p className="text-amber-300">
                              Cap / blocage dominant (cycles + résidu) :{" "}
                              <span className="font-medium">{formatCapBlockerReason(combo.capDiagnosticsV2.dominantFillBlocker.reason)}</span>
                              {" "}× {combo.capDiagnosticsV2.dominantFillBlocker.count}
                            </p>
                          )}
                          {combo.capDiagnosticsV2.lostPremiumNoteFr && (
                            <p className="text-amber-300">{combo.capDiagnosticsV2.lostPremiumNoteFr}</p>
                          )}
                          {Array.isArray(combo.capDiagnosticsV2.balancedPerPickInsights) && combo.capDiagnosticsV2.balancedPerPickInsights.length > 0 && (
                            <div className="text-[10px] text-slate-400 space-y-0.5 border-t border-sky-900 pt-1 mt-1">
                              <p className="font-medium text-slate-300">Efficacité par ligne (prime / capital déployable)</p>
                              <ul className="list-disc pl-4 space-y-0.5">
                                {combo.capDiagnosticsV2.balancedPerPickInsights.map((row) => (
                                  <li key={row.ticker}>
                                    <span className="font-semibold text-slate-200">{row.ticker}</span>
                                    {row.premiumUsdPer1000Collateral != null && (
                                      <> · {row.premiumUsdPer1000Collateral.toFixed(1)} $ prime / 1000 $ collat</>
                                    )}
                                    {row.shareOfDeployablePct != null && (
                                      <> · {row.shareOfDeployablePct.toFixed(1)}% du déployable</>
                                    )}
                                    {row.phase && <> · phase {row.phase}</>}
                                    {row.weeklyYieldPct != null && <> · yield {Number(row.weeklyYieldPct).toFixed(2)}%</>}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                      {(combo.capDiagnosticsV2.blockerSummaryMerged ?? []).slice(0, 6).map((b, idx) => (
                        <div key={`${b.reason}-${b.source}-${idx}`} className="flex gap-2 justify-between leading-snug">
                          <span className="font-medium text-slate-200">{formatCapBlockerReason(b.reason)}</span>
                          <span className="shrink-0 text-slate-500">{b.count}x · <span className="italic">{b.source ?? "?"}</span></span>
                        </div>
                      ))}
                      {"potentialPremiumStrandedUsd" in (combo.capDiagnosticsV2 ?? {}) &&
                        combo.capDiagnosticsV2.potentialPremiumStrandedUsd != null &&
                        combo.capDiagnosticsV2.potentialPremiumStrandedUsd > 10 && (
                        <p className="text-amber-400">
                          Premium théorique bloquée (caps diversification) ≈{" "}
                          {combo.capDiagnosticsV2.potentialPremiumStrandedUsd.toFixed(0)}$
                        </p>
                      )}
                      {"leftoverDensityPass" in (combo.capDiagnosticsV2 ?? {}) && combo.capDiagnosticsV2.leftoverDensityPass?.enabled === true ? (
                        <p className="text-sky-400">
                          Passe leftover densité · +{combo.capDiagnosticsV2.leftoverDensityPass.adds ?? 0} lot(s)
                          {(combo.capDiagnosticsV2.leftoverDensityPass.premiumDeltaUsd ?? 0) !== 0
                            ? <> · Δ prime ≈ {combo.capDiagnosticsV2.leftoverDensityPass.premiumDeltaUsd.toFixed(0)}$</>
                            : ""}
                        </p>
                      ) : combo.capDiagnosticsV2.leftoverDensityPass ? (
                        <p className="text-slate-400">Passe leftover densité inactive pour ce bucket.</p>
                      ) : null}
                      {(combo.capDiagnosticsV2.replacementHints?.length ?? 0) > 0 && (
                        <div className="text-[11px] text-slate-500">
                          Alternatives encore bloquées (top densité wedge) ·{" "}
                          {combo.capDiagnosticsV2.replacementHints.slice(0, 4).map((h) =>
                            `${h.ticker}:${h.primaryBlocker}`).join(" · ")}
                        </div>
                      )}
                      <p className="text-[10px] italic text-slate-400 leading-snug">
                        Feature flags JSON localStorage&nbsp;: clé wheelCapitalComboOptimizerV2Flags — désactive avec {`{"capDiagnosticsEnabled":false}`}.
                      </p>
                    </div>
                  </details>
                )}
                {combo.crossModeOverlap?.crossModeWarnings?.length > 0 && (
                  <div className="mt-0.5">
                    {combo.crossModeOverlap.crossModeWarnings.map((w, i) => (
                      <p key={i} className="text-xs text-slate-400">{w}</p>
                    ))}
                  </div>
                )}
              </div>
              <Badge className="rounded-full border border-slate-600 bg-slate-800/50 text-slate-300">
                Libre dép. {Math.max(0, usableCapital - combo.totalCapital).toFixed(0)}$
              </Badge>
            </div>

            <div className="mt-4 space-y-2">
              {combo.picks.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-600 bg-slate-800/50 p-3 text-sm text-slate-500">
                  {combo.emptyMessage ?? "Aucune combinaison propre selon les critères actuels."}
                </div>
              )}
              {combo.picks.map((pick) => (
                <div
                  key={`${combo.label}-${pick.ticker}`}
                  className="rounded-xl border border-slate-700 bg-slate-800/50 px-3 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-slate-300">
                    <button
                      type="button"
                      onClick={() => onTickerClick?.(pick.ticker)}
                      title={`Aller à la carte principale ${pick.ticker}`}
                      className="cursor-pointer font-bold text-slate-100 transition hover:text-sky-400 hover:underline"
                    >
                      {pick.ticker}
                    </button>
                    {pick.qualityTier && pick.qualityTier !== "high" && (
                      <span className={cn(
                        "text-xs font-medium",
                        pick.qualityTier === "medium" && "text-slate-400",
                        pick.qualityTier === "speculative" && "text-amber-500",
                        pick.qualityTier === "avoid" && "text-rose-400",
                      )}>
                        {pick.qualityTier}
                      </span>
                    )}
                    <span className="text-slate-300">|</span>
                    <span className="rounded bg-slate-700 px-1.5 py-0.5 text-xs font-semibold text-slate-300">
                      {pick.mode ?? "—"}{pick.grade ? ` ${pick.grade}` : ""}
                    </span>
                    <span className="text-slate-300">|</span>
                    <span>PUT {pick.strike}$</span>
                    <span className="text-slate-300">|</span>
                    <span>{pick.premiumKind || "bid"} {pick.premiumUnit != null ? `${Number(pick.premiumUnit).toFixed(2)}$` : "—"}</span>
                    <span className="text-slate-300">|</span>
                    <span>spread {pick.spreadPct != null ? `${Number(pick.spreadPct).toFixed(1)}%` : "—"}</span>
                    <span className="text-slate-300">|</span>
                    <span>rendement {pick.weeklyReturn.toFixed(2)}%</span>
                    <span className="text-slate-300">|</span>
                    <span>dist {pick.distancePct != null ? `${Number(pick.distancePct).toFixed(1)}%` : "—"}</span>
                    <span className="text-slate-300">|</span>
                    <span>×{pick.contracts}</span>
                    <span className="text-slate-300">|</span>
                    <span
                      title="Phase greedy / filler / optimiseur leftover"
                      className={cn(
                        "rounded border px-1 text-[11px]",
                        pick.comboAllocationPhase === "leftover_density_v2" && "border-sky-600 bg-sky-950/55 text-sky-200",
                        pick.comboAllocationPhase === "filler_primary" && "border-amber-800 bg-amber-950/40 text-amber-300",
                        pick.comboAllocationPhase === "primary_soft_cap" && "border-violet-700 bg-violet-950/50 text-violet-200",
                        (!pick.comboAllocationPhase || pick.comboAllocationPhase === "primary_strict") && "border-slate-700 bg-slate-900 text-slate-400",
                      )}
                    >
                      {pick.comboAllocationPhase ?? "primary_strict"}
                    </span>
                    <span className="text-slate-300">|</span>
                    <span>capital {pick.capitalRequired.toFixed(0)}$</span>
                    <span className="text-slate-300">|</span>
                    <span>prime {pick.premiumCollected.toFixed(0)}$</span>
                    <span className="text-slate-300">|</span>
                    <span>
                      POP{" "}
                      {pick.popEstimate != null && Number.isFinite(Number(pick.popEstimate))
                        ? `${Math.round(Number(pick.popEstimate))}%`
                        : "—"}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-400">
                    <span
                      className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-medium"
                      title={pick.selectionTooltip ?? undefined}
                    >
                      Score {pick.selectionScore}
                    </span>
                    {pick.source && <span>{pick.source}</span>}
                    {pick.selectionSummary && <span>{pick.selectionSummary.replace(/\byield\b/g, "rendement").replace(/\bquality\b/g, "qualité").replace(/\brisk\b/g, "risque")}</span>}
                    {combo.label === "BALANCED" && pick.balancedInstitutionalV3Pick && (
                      <span className="text-sky-300">
                        {pick.balancedInstitutionalV3Pick.premiumUsdPer1000Collateral != null && (
                          <>Efficacité prime ≈ {pick.balancedInstitutionalV3Pick.premiumUsdPer1000Collateral.toFixed(1)} $/1000$ collat · </>
                        )}
                        {pick.balancedInstitutionalV3Pick.deployableCapitalSharePct != null && (
                          <>part du déployable {pick.balancedInstitutionalV3Pick.deployableCapitalSharePct.toFixed(1)}%</>
                        )}
                      </span>
                    )}
                    {(pick.concentrationTheme || (pick.qualityWarnings?.length > 0 && pick.qualityTier !== "high" && pick.qualityTier !== "medium")) && (
                      <span className="text-amber-500">
                        {pick.concentrationTheme && <span className="mr-1">thème: {pick.concentrationTheme}</span>}
                        {pick.qualityWarnings
                          ?.filter((w) => w !== "Crypto miner" && w !== "High beta growth")
                          .slice(0, 2)
                          .join(" · ")}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 text-sm text-slate-400">
              Prime totale estimée :{" "}
              <span className="font-semibold text-slate-100">
                {combo.picks.reduce((sum, p) => sum + p.premiumCollected, 0).toFixed(0)}$
              </span>
              {" "}· Capital du compte :{" "}
              <span className="font-semibold text-slate-100">{capital.toFixed(0)}$</span>
            </div>

            {!combo.capitalTargetReached && combo.capitalShortfallReason && (
              <div className="mt-2 rounded-xl border border-amber-800 bg-amber-950/40 px-3 py-2 text-xs text-amber-400">
                Capital non utilisé — {formatCapitalShortfallReason(combo.capitalShortfallReason)}
              </div>
            )}
          </div>
          );
        })}
        <CapitalCombosInspector
          combos={combos}
          candidates={candidates}
          capital={capital}
          maxCapitalPct={maxCapitalPct}
          maxPositions={maxPositions}
          ibkrRejectedSymbols={ibkrRejectedSymbols}
        />
          </div>
        </details>
      </CardContent>
    </Card>
  );
}

function formatPipelineYesNo(value) {
  return value ? "oui" : "non";
}

function formatPipelineLegSummary(leg) {
  if (!leg || leg.status === "absent") return "—";
  const parts = [];
  if (leg.strike != null) parts.push(`strike ${leg.strike}`);
  if (leg.yieldPct != null) parts.push(`yield ${leg.yieldPct.toFixed(2)}%`);
  if (leg.spreadPct != null) parts.push(`spread ${leg.spreadPct.toFixed(1)}%`);
  if (leg.bid != null) parts.push(`bid ${leg.bid.toFixed(2)}`);
  parts.push(`[${leg.status}]`);
  return parts.join(" · ");
}

/** Panneau read-only sous la barre de recherche (ticker exact seulement). */
function TickerPipelineDiagnosticPanel({ diagnostic }) {
  if (!diagnostic) return null;
  const d = diagnostic;
  return (
    <div
      className="mt-2 w-full rounded-xl border border-cyan-800/50 bg-cyan-950/25 p-3 text-xs text-cyan-50"
      data-testid="ticker-pipeline-diagnostic"
    >
      <p className="font-semibold text-cyan-100">
        Diagnostic pipeline pour {d.ticker}
      </p>
      <ul className="mt-2 space-y-1 text-cyan-100/90">
        <li>
          Yahoo : {formatPipelineYesNo(d.presentInYahoo)}
          {d.yahooRank != null ? ` · rang ${d.yahooRank}` : ""}
          {d.yahooStatus ? ` · ${d.yahooStatus}` : ""}
        </li>
        <li>IBKR envoyé : {formatPipelineYesNo(d.sentToIbkr)}</li>
        <li>IBKR shortlist : {formatPipelineYesNo(d.presentInIbkrShortlist)}</li>
        <li>
          IBKR rejected : {formatPipelineYesNo(d.presentInIbkrRejected)}
          {d.ibkrRejectReason ? ` · ${d.ibkrRejectReason}` : ""}
        </li>
        <li>Cartes primaires (backendCandidates) : {formatPipelineYesNo(d.presentInBackendCandidates)}</li>
        <li>Cartes filtrées (filtered) : {formatPipelineYesNo(d.presentInFilteredCards)}</li>
        <li>Combo pool éligible : {formatPipelineYesNo(d.presentInComboPool)}</li>
        <li>SAFE : {formatPipelineLegSummary(d.safeCandidateSummary)}</li>
        <li>AGGRESSIVE : {formatPipelineLegSummary(d.aggressiveCandidateSummary)}</li>
        <li>
          Mode sélectionné : {d.selectedMode ?? "—"} · Statut : {d.finalStatus ?? "—"}
        </li>
        <li>
          Perdu à l&apos;étape : {d.lostAtStep ?? "— (visible)"}
        </li>
        <li className="text-cyan-200/80">Raison probable : {d.likelyReason ?? "—"}</li>
        {d.yahooRejectReason ? (
          <li className="text-amber-200/90">Rejet Yahoo : {d.yahooRejectReason}</li>
        ) : null}
        {d.preScanAbsentReason ? (
          <li className="text-amber-200/90">Pré-scan : {d.preScanAbsentReason}</li>
        ) : null}
        <li className="mt-1 border-t border-cyan-900/40 pt-2 font-medium text-cyan-100">Sonde OTM watchlist</li>
        <li>
          UI sélectionnée : {d.liquidityOtmProbePctSelected ?? "—"}% · Dernier rebuild :{" "}
          {d.liquidityOtmProbePctApplied ?? "—"}%
        </li>
        <li>Pool scan : {d.poolSource ?? "—"}</li>
        <li>
          Statut sonde : {d.otmProbeStatus ?? "unknown"}
          {d.otmProbeNote ? ` · ${d.otmProbeNote}` : ""}
        </li>
        {d.otmMismatchNote ? (
          <li className="text-amber-200/90">{d.otmMismatchNote}</li>
        ) : null}
        {d.otmRebuildRequiredMessage ? (
          <li className="text-amber-200/90">{d.otmRebuildRequiredMessage}</li>
        ) : null}
      </ul>
      {Array.isArray(d.pipelineTrace) && d.pipelineTrace.length > 0 && (
        <div className="mt-3 overflow-x-auto rounded-lg border border-cyan-900/40">
          <table className="min-w-full text-[10px]">
            <thead>
              <tr className="border-b border-cyan-900/50 text-left text-cyan-300/80">
                <th className="px-2 py-1 font-medium">Étape</th>
                <th className="px-2 py-1 font-medium">Présent</th>
                <th className="px-2 py-1 font-medium">Raison</th>
                <th className="px-2 py-1 font-medium">Source</th>
              </tr>
            </thead>
            <tbody>
              {d.pipelineTrace.map((row) => (
                <tr key={row.step} className="border-b border-cyan-950/60 text-cyan-100/85">
                  <td className="px-2 py-1">{row.step}</td>
                  <td className="px-2 py-1">{formatPipelineYesNo(row.present)}</td>
                  <td className="px-2 py-1">{row.reason || "—"}</td>
                  <td className="px-2 py-1 text-cyan-300/60">{row.source || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[10px] text-cyan-300/60">
        Lecture seule — ne modifie pas les cartes ni les combos. Source : {d.dataSource ?? "—"}
        {d.topN != null ? ` · topN ${d.topN}` : ""}
        {d.ibkrAutoMaxTickers != null ? ` · IBKR depth ${d.ibkrAutoMaxTickers}` : ""}
      </p>
    </div>
  );
}

/** Libellé court du statut IBKR. */
function formatIbkrFunnelStatus(status) {
  switch (status) {
    case "retained":
      return "retenu";
    case "rejected":
      return "rejeté";
    case "error":
      return "erreur";
    case "nonTested":
      return "non testé";
    default:
      return status ?? "—";
  }
}

/** Panneau global — funnel complet Yahoo → IBKR (Top 250 → shortlist → envoyés → retenus/rejetés). */
function YahooIbkrFunnelPanel({ rows, summary, topN, ibkrSentCount, onExportCsv }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const shortlistRequested = Number.isFinite(Number(topN)) ? Number(topN) : null;
  const sentReal = Number.isFinite(Number(ibkrSentCount))
    ? Number(ibkrSentCount)
    : summary?.sentIbkr ?? 0;
  const notSentFromShortlist =
    shortlistRequested != null ? Math.max(0, shortlistRequested - sentReal) : summary?.notSentIbkr ?? 0;
  return (
    <div
      className="mt-4 rounded-xl border border-amber-900/40 bg-amber-950/15 p-3"
      data-testid="yahoo-ibkr-funnel-diagnostics"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-amber-100">Funnel Yahoo → IBKR ({rows.length})</p>
        {typeof onExportCsv === "function" && (
          <button
            type="button"
            className="rounded-lg border border-amber-800/60 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-900/30"
            onClick={onExportCsv}
          >
            Exporter CSV
          </button>
        )}
      </div>
      {summary && (
        <p className="mt-1 text-[11px] text-amber-200/80">
          {`Top 250: ${summary.inTop250} · Shortlist utilisée: ${summary.inShortlist}`}
          {shortlistRequested != null ? ` · Shortlist demandée (topN): ${shortlistRequested}` : ""}
          {` · Envoyés IBKR: ${sentReal} · Non envoyés: ${notSentFromShortlist}`}
          {` · Retenus: ${summary.retained} · Rejetés: ${summary.rejected} · Erreurs: ${summary.error} · Non testés: ${summary.nonTested}`}
        </p>
      )}
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="min-w-full text-[11px] text-amber-50/90">
          <thead>
            <tr className="border-b border-amber-900/40 text-left text-amber-200/70">
              <th className="px-2 py-1">Ticker</th>
              <th className="px-2 py-1">Rang Yahoo</th>
              <th className="px-2 py-1">Score Yahoo</th>
              <th className="px-2 py-1">Top 250</th>
              <th className="px-2 py-1">Shortlist</th>
              <th className="px-2 py-1">Envoyé IBKR</th>
              <th className="px-2 py-1">Statut IBKR</th>
              <th className="px-2 py-1">Étape perdue</th>
              <th className="px-2 py-1">Raison exacte</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className="border-b border-amber-950/50">
                <td className="px-2 py-1 font-medium">{row.ticker}</td>
                <td className="px-2 py-1">{row.yahooRank ?? "—"}</td>
                <td className="px-2 py-1">{row.yahooScore ?? "—"}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(row.inTop250)}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(row.inShortlist)}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(row.sentIbkr)}</td>
                <td className="px-2 py-1">{formatIbkrFunnelStatus(row.ibkrStatus)}</td>
                <td className="px-2 py-1">{row.stageLost ?? "—"}</td>
                <td className="px-2 py-1 text-amber-100/70">{row.reason || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Panneau « Mémoire IBKR » — LECTURE SEULE.
 * Affiche un résumé read-only de ticker_scan_memory (Phase 1) : quels tickers
 * sont souvent retenus / rejetés par IBKR. Ne déclenche AUCUN scan IBKR, ne
 * touche pas au scoring / sélection. Source unique : GET /ticker-scan-memory.
 * ────────────────────────────────────────────────────────────────────────── */
const IBKR_MEMORY_REJECT_REASON_FR = {
  no_safe_candidate_meets_min_premium: "Prime insuffisante",
  no_bid_ask: "Aucun bid/ask",
  timeout: "Délai dépassé",
  ibkr_unavailable: "IBKR indisponible",
  no_market_data: "Aucune donnée marché",
  spread_too_wide: "Spread trop large",
  unknown: "Raison inconnue",
};

/** Traduit une raison de rejet IBKR en français (fallback : raison brute). */
function translateIbkrRejectReason(reason) {
  if (!reason) return "—";
  return IBKR_MEMORY_REJECT_REASON_FR[reason] || String(reason);
}

/** Ratio décimal (0.0054) → pourcentage français (« 0,54 % »). null → « — ». */
function formatMemoryRatioPct(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return `${(Number(value) * 100).toLocaleString("fr-FR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} %`;
}

/** Date ISO → format court français (« 31 mai 2026 »). null/invalide → « — ». */
function formatMemoryDateFr(value) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

/** Affiche un entier sans plantage si valeur manquante. */
function memoryCount(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? "—" : String(value);
}

function IbkrMemoryPanel({ apiBase, refreshKey = 0 }) {
  const [open, setOpen] = useState(false);
  // idle | loading | ok | empty | error
  const [status, setStatus] = useState("idle");
  const [data, setData] = useState(null);

  const loadMemory = useCallback(async () => {
    setStatus((prev) => (prev === "idle" ? "loading" : prev));
    try {
      const res = await fetch(`${apiBase}/ticker-scan-memory`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || json.ok === false) throw new Error("payload");
      setData(json);
      setStatus(Number(json.totalTickers) > 0 ? "ok" : "empty");
    } catch {
      // Échec discret : le dashboard continue de fonctionner, pas de boucle.
      setData(null);
      setStatus("error");
    }
  }, [apiBase]);

  // Montage initial + refresh après chaque scan IBKR terminé (refreshKey). Pas de polling.
  useEffect(() => {
    loadMemory();
  }, [loadMemory, refreshKey]);

  const total = Number(data?.totalTickers) || 0;
  const shortHistory = status === "ok" && total < 40;

  const renderTable = (columns, rows, mapRow, keyFn) => {
    if (!Array.isArray(rows) || rows.length === 0) {
      return <p className="text-xs text-slate-500">Aucune donnée pour le moment.</p>;
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="text-slate-400">
              {columns.map((c) => (
                <th key={c} className="border-b border-slate-700 px-2 py-1 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={keyFn(row, i)} className="text-slate-200">
                {mapRow(row).map((cell, j) => (
                  <td key={j} className="border-b border-slate-800 px-2 py-1">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const section = (title, node) => (
    <div className="mt-4">
      <h4 className="mb-2 text-sm font-semibold text-slate-200">{title}</h4>
      {node}
    </div>
  );

  return (
    <div className="mb-6 rounded-[28px] border border-slate-700 bg-slate-900 shadow-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="flex items-center gap-3">
          <span className="text-base font-semibold text-slate-100">Mémoire IBKR</span>
          <Badge className="rounded-full border-amber-700/60 bg-amber-950/40 text-amber-300">
            Lecture seule
          </Badge>
          {status === "ok" ? (
            <span className="text-xs text-slate-400">{total} tickers mémorisés</span>
          ) : status === "error" ? (
            <span className="text-xs text-slate-500">Mémoire IBKR indisponible</span>
          ) : null}
        </span>
        <span className="text-xs text-slate-500">{open ? "▲ masquer" : "▼ afficher"}</span>
      </button>

      {open ? (
        <div className="border-t border-slate-800 px-5 pb-5 pt-4">
          {status === "loading" || status === "idle" ? (
            <p className="text-sm text-slate-500">Chargement de la mémoire IBKR…</p>
          ) : status === "error" ? (
            <p className="text-sm text-slate-500">Mémoire IBKR indisponible</p>
          ) : status === "empty" ? (
            <p className="text-sm text-slate-400">
              Mémoire IBKR pas encore suffisante — lancer quelques scans IBKR.
            </p>
          ) : (
            <>
              {/* 1. Résumé */}
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-lg font-semibold text-slate-100">{total} tickers mémorisés</span>
                <span className="text-xs text-slate-500">Historique court — lecture seule</span>
              </div>
              {shortHistory ? (
                <p className="mt-2 rounded-lg border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
                  Historique court — ne pas utiliser comme score
                </p>
              ) : null}

              {/* 2. Top retenus IBKR */}
              {section(
                "Top retenus IBKR",
                renderTable(
                  ["Symbole", "Retenus / envoyés", "Dernière rétention"],
                  data?.topRetained,
                  (r) => [
                    <span className="font-semibold">{r.symbol}</span>,
                    `${memoryCount(r.timesIbkrRetained)} / ${memoryCount(r.timesSentIbkr)}`,
                    formatMemoryDateFr(r.lastRetainedAt),
                  ],
                  (r, i) => `ret-${r.symbol ?? i}`
                )
              )}

              {/* 3. Rejets récurrents */}
              {section(
                "Rejets récurrents",
                renderTable(
                  ["Symbole", "Rejetés / envoyés", "Raison principale"],
                  data?.topRejected,
                  (r) => [
                    <span className="font-semibold">{r.symbol}</span>,
                    `${memoryCount(r.timesIbkrRejected)} / ${memoryCount(r.timesSentIbkr)}`,
                    translateIbkrRejectReason(r.mainRejectReason),
                  ],
                  (r, i) => `rej-${r.symbol ?? i}`
                )
              )}

              {/* 4. Prime insuffisante récurrente */}
              {section(
                "Prime insuffisante récurrente",
                renderTable(
                  ["Symbole", "Série", "Prime moyenne"],
                  data?.topNoPremium,
                  (r) => [
                    <span className="font-semibold">{r.symbol}</span>,
                    memoryCount(r.consecutiveNoPremium),
                    formatMemoryRatioPct(r.avgPremiumYield),
                  ],
                  (r, i) => `noprem-${r.symbol ?? i}`
                )
              )}

              {/* 5. Données absentes / aucun bid-ask */}
              {section(
                "Données absentes / aucun bid-ask",
                renderTable(
                  ["Symbole", "Série no data", "Nombre no data"],
                  data?.topNoData,
                  (r) => [
                    <span className="font-semibold">{r.symbol}</span>,
                    memoryCount(r.consecutiveNoData),
                    memoryCount(r.timesNoData),
                  ],
                  (r, i) => `nodata-${r.symbol ?? i}`
                )
              )}

              {/* 6. Spread problématique */}
              {section(
                "Spread problématique",
                renderTable(
                  ["Symbole", "Série spread", "Spread moyen"],
                  data?.topWideSpread,
                  (r) => [
                    <span className="font-semibold">{r.symbol}</span>,
                    memoryCount(r.consecutiveWideSpread),
                    formatMemoryRatioPct(r.avgSpreadPct),
                  ],
                  (r, i) => `spread-${r.symbol ?? i}`
                )
              )}

              {/* 7. Raisons de rejet principales */}
              {section(
                "Raisons de rejet principales",
                renderTable(
                  ["Raison", "Nombre"],
                  data?.topRejectReasons,
                  (r) => [translateIbkrRejectReason(r.reason), memoryCount(r.count)],
                  (r, i) => `reason-${r.reason ?? i}`
                )
              )}

              <p className="mt-4 text-[11px] text-slate-600">
                Panneau read-only : aucune influence sur SAFE/AGG, Expected Move, POP, quick gate
                ou la sélection des tickers.
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────────────
 * Panneau « Archive Funnel » — LECTURE SEULE.
 * Consulte les sessions archivées via GET /scan-funnel/sessions.
 * Ne déclenche AUCUN scan Yahoo/IBKR.
 * ────────────────────────────────────────────────────────────────────────── */
function ScanFunnelArchivePanel({ apiBase }) {
  const [open, setOpen] = useState(false);
  const [listStatus, setListStatus] = useState("idle");
  const [listError, setListError] = useState("");
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detailStatus, setDetailStatus] = useState("idle");
  const [detailError, setDetailError] = useState("");
  const [detailSession, setDetailSession] = useState(null);
  const [detailEvents, setDetailEvents] = useState([]);
  const [tickerSearch, setTickerSearch] = useState("");

  const loadSessions = useCallback(async () => {
    setListStatus("loading");
    setListError("");
    try {
      const res = await fetch(`${apiBase}/scan-funnel/sessions?limit=20`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (!json || json.ok === false) {
        throw new Error(json?.error || "Réponse invalide");
      }
      const rows = Array.isArray(json.sessions) ? json.sessions : [];
      setSessions(rows);
      setListStatus(rows.length > 0 ? "ok" : "empty");
    } catch (err) {
      setSessions([]);
      setListStatus("error");
      setListError(String(err?.message || "Erreur réseau"));
    }
  }, [apiBase]);

  const loadSessionDetail = useCallback(
    async (scanSessionId) => {
      const id = String(scanSessionId ?? "").trim();
      if (!id) return;
      setSelectedId(id);
      setDetailStatus("loading");
      setDetailError("");
      setDetailSession(null);
      setDetailEvents([]);
      setTickerSearch("");
      try {
        const res = await fetch(`${apiBase}/scan-funnel/sessions/${encodeURIComponent(id)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json || json.ok === false) {
          throw new Error(json?.error || "Session introuvable");
        }
        setDetailSession(json.session ?? null);
        setDetailEvents(Array.isArray(json.events) ? json.events : []);
        setDetailStatus("ok");
      } catch (err) {
        setDetailStatus("error");
        setDetailError(String(err?.message || "Erreur réseau"));
      }
    },
    [apiBase]
  );

  useEffect(() => {
    if (open) loadSessions();
  }, [open, loadSessions]);

  const detailSummary = useMemo(
    () =>
      detailSession ? buildFunnelSessionSummary(detailSession, detailEvents) : null,
    [detailSession, detailEvents]
  );

  const symbolsByStage = useMemo(
    () => groupSymbolsByStage(detailEvents),
    [detailEvents]
  );

  const tickerChain = useMemo(() => {
    const q = normalizeFunnelTickerQuery(tickerSearch);
    if (!q || detailEvents.length === 0) return [];
    return getTickerFunnelChain(detailEvents, q);
  }, [tickerSearch, detailEvents]);

  const renderSummaryGrid = (summary) => (
    <div className="mt-3 grid grid-cols-2 gap-2 text-xs md:grid-cols-5">
      {[
        ["Pré-IBKR", summary.preIbkr],
        ["Yahoo retournés", summary.yahooReturned],
        ["Yahoo rejetés", summary.yahooRejected],
        ["Crypto bloqués", summary.cryptoBlocked],
        ["Watchlist rejetés", summary.watchlistRejected],
        ["IBKR envoyés", summary.ibkrSent],
        ["IBKR retenus", summary.ibkrRetained],
        ["IBKR rejetés", summary.ibkrRejected],
        ["UI affichés", summary.uiDisplayed],
        ["Retenus non affichés", summary.retainedNotDisplayed],
      ].map(([label, value]) => (
        <div key={label} className="rounded-lg border border-slate-800 bg-slate-950/40 px-2 py-1.5">
          <span className="text-slate-500">{label}</span>
          <div className="font-semibold text-slate-100">{funnelArchiveCount(value)}</div>
        </div>
      ))}
    </div>
  );

  const renderStageGroups = () => (
    <div className="mt-4 space-y-3">
      {FUNNEL_ARCHIVE_STAGE_ORDER.map((stage) => {
        const symbols = symbolsByStage[stage];
        if (!symbols?.length) return null;
        const preview = symbols.slice(0, 24).join(", ");
        const extra = symbols.length > 24 ? ` (+${symbols.length - 24})` : "";
        return (
          <div key={stage} className="rounded-lg border border-slate-800 bg-slate-950/30 px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-semibold text-violet-200">{funnelStageLabel(stage)}</span>
              <span className="text-[11px] text-slate-500">({symbols.length})</span>
            </div>
            <p className="mt-1 break-words text-[11px] leading-relaxed text-slate-300">
              {preview}
              {extra}
            </p>
          </div>
        );
      })}
    </div>
  );

  const renderTickerChain = () => {
    const q = normalizeFunnelTickerQuery(tickerSearch);
    if (!q) return null;
    if (tickerChain.length === 0) {
      return (
        <p className="mt-2 text-xs text-slate-500">
          Aucune trace de <span className="font-medium text-slate-300">{q}</span> dans cette session.
        </p>
      );
    }
    return (
      <div className="mt-3 rounded-lg border border-violet-900/50 bg-violet-950/20 px-3 py-2">
        <p className="text-xs font-semibold text-violet-100">{q}</p>
        <ul className="mt-2 space-y-1.5 text-[11px] text-slate-300">
          {tickerChain.map((ev) => {
            const strike = ev?.metadata?.selectedStrike;
            const rank = ev?.rank ?? ev?.metadata?.rank;
            return (
              <li key={`${ev.stage}-${ev.id ?? ev.symbol}`} className="border-l-2 border-violet-800/60 pl-2">
                <span className="font-medium text-violet-200">{ev.stage}</span>
                {rank != null ? (
                  <span className="text-slate-500"> · rank {rank}</span>
                ) : null}
                {strike != null ? (
                  <span className="text-slate-500"> · strike {strike}</span>
                ) : null}
                {ev.reason ? (
                  <span className="block text-slate-400">reason: {ev.reason}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    );
  };

  return (
    <div
      className="mb-6 rounded-[28px] border border-slate-700 bg-slate-900 shadow-sm"
      data-testid="scan-funnel-archive-panel"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-left"
      >
        <span className="flex flex-wrap items-center gap-3">
          <span className="text-base font-semibold text-slate-100">Archive Funnel</span>
          <Badge className="rounded-full border-violet-700/60 bg-violet-950/40 text-violet-300">
            Lecture seule
          </Badge>
          {listStatus === "ok" ? (
            <span className="text-xs text-slate-400">{sessions.length} session(s)</span>
          ) : listStatus === "error" ? (
            <span className="text-xs text-slate-500">Archive indisponible</span>
          ) : null}
        </span>
        <span className="text-xs text-slate-500">{open ? "▲ masquer" : "▼ afficher"}</span>
      </button>

      {open ? (
        <div className="border-t border-slate-800 px-5 pb-5 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-slate-400">
              Historique des scans archivés (Yahoo → IBKR → UI). Aucun scan n&apos;est déclenché ici.
            </p>
            <button
              type="button"
              className="rounded-lg border border-slate-700 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              onClick={loadSessions}
              disabled={listStatus === "loading"}
            >
              Actualiser
            </button>
          </div>

          {listStatus === "loading" || listStatus === "idle" ? (
            <p className="mt-3 text-sm text-slate-500">Chargement des sessions archivées…</p>
          ) : listStatus === "error" ? (
            <p className="mt-3 text-sm text-amber-300">
              Impossible de charger l&apos;archive Funnel ({listError || "erreur"}).
            </p>
          ) : listStatus === "empty" ? (
            <p className="mt-3 text-sm text-slate-400">Aucune archive Funnel disponible.</p>
          ) : (
            <>
              <div className="mt-3 max-h-56 overflow-auto rounded-xl border border-slate-800">
                <table className="min-w-full text-left text-[11px] text-slate-300">
                  <thead className="sticky top-0 bg-slate-900">
                    <tr className="border-b border-slate-800 text-slate-400">
                      <th className="px-2 py-1.5 font-medium">Session</th>
                      <th className="px-2 py-1.5 font-medium">Date</th>
                      <th className="px-2 py-1.5 font-medium">Exp.</th>
                      <th className="px-2 py-1.5 font-medium">DTE</th>
                      <th className="px-2 py-1.5 font-medium">Pool</th>
                      <th className="px-2 py-1.5 font-medium">Capture</th>
                      <th className="px-2 py-1.5 font-medium">Pré-IBKR</th>
                      <th className="px-2 py-1.5 font-medium">Yahoo ret.</th>
                      <th className="px-2 py-1.5 font-medium">IBKR env.</th>
                      <th className="px-2 py-1.5 font-medium">IBKR ret.</th>
                      <th className="px-2 py-1.5 font-medium">IBKR rej.</th>
                      <th className="px-2 py-1.5 font-medium">UI</th>
                      <th className="px-2 py-1.5 font-medium">Events</th>
                      <th className="px-2 py-1.5 font-medium">Complet</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((row) => {
                      const id = row.scan_session_id;
                      const selected = selectedId === id;
                      const complete = isFunnelArchiveComplete(row);
                      return (
                        <tr
                          key={id}
                          className={`cursor-pointer border-b border-slate-800/80 hover:bg-slate-800/50 ${
                            selected ? "bg-violet-950/30" : ""
                          }`}
                          onClick={() => loadSessionDetail(id)}
                        >
                          <td className="px-2 py-1.5 font-medium text-violet-200">{id}</td>
                          <td className="px-2 py-1.5 whitespace-nowrap">
                            {formatFunnelArchiveTimestamp(row.scan_timestamp || row.created_at)}
                          </td>
                          <td className="px-2 py-1.5">{row.selected_expiration ?? "—"}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.dte_at_scan)}</td>
                          <td className="px-2 py-1.5">{row.pool_source ?? "—"}</td>
                          <td className="px-2 py-1.5">{row.capture_source ?? "—"}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.pre_ibkr_count)}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.yahoo_returned_count)}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.ibkr_sent_count)}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.ibkr_retained_count)}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.ibkr_rejected_count)}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.ui_displayed_count)}</td>
                          <td className="px-2 py-1.5">{funnelArchiveCount(row.event_count)}</td>
                          <td className="px-2 py-1.5">
                            {complete === true ? "oui" : complete === false ? "non" : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {selectedId ? (
                <div className="mt-4 rounded-xl border border-violet-900/40 bg-violet-950/10 p-3">
                  <p className="text-sm font-semibold text-slate-100">
                    Session {selectedId}
                  </p>
                  {detailStatus === "loading" ? (
                    <p className="mt-2 text-xs text-slate-500">Chargement du détail…</p>
                  ) : detailStatus === "error" ? (
                    <p className="mt-2 text-xs text-amber-300">
                      Impossible de charger la session ({detailError || "erreur"}).
                    </p>
                  ) : detailSummary ? (
                    <>
                      {renderSummaryGrid(detailSummary)}
                      <div className="mt-4">
                        <label className="mb-1 block text-xs font-medium text-slate-400">
                          Recherche ticker
                        </label>
                        <Input
                          type="text"
                          placeholder="Ex. TQQQ, BAC, AMD…"
                          value={tickerSearch}
                          onChange={(e) => setTickerSearch(e.target.value)}
                          className="max-w-xs rounded-lg border-slate-700 text-sm"
                        />
                        {renderTickerChain()}
                      </div>
                      <details className="mt-4" open>
                        <summary className="cursor-pointer text-xs font-semibold text-slate-200">
                          Tickers par étape
                        </summary>
                        {renderStageGroups()}
                      </details>
                    </>
                  ) : null}
                </div>
              ) : (
                <p className="mt-3 text-xs text-slate-500">
                  Cliquez une session pour voir le détail et rechercher un ticker.
                </p>
              )}
            </>
          )}

          <p className="mt-4 text-[11px] text-slate-600">
            Panneau read-only : consulte uniquement l&apos;archive persistée. Aucun appel scan_shortlist
            ni IBKR.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function PreIbkrCutDiagnosticsPanel({ rows, summary, onExportCsv }) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  return (
    <details
      className="mt-4 rounded-xl border border-amber-900/40 bg-amber-950/15 p-3"
      data-testid="pre-ibkr-cut-diagnostics"
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 [&::-webkit-details-marker]:hidden">
        <span className="font-medium text-amber-100">Tickers coupés avant IBKR ({rows.length})</span>
        <span className="text-[10px] text-amber-300/50">table lourde repliée par défaut — ouvrir pour inspecter les {rows.length} tickers coupés</span>
      </summary>
      <p className="mt-2 text-[10px] text-amber-300/60">
        Table détaillée conservée pour audit. Ouvre seulement si tu veux inspecter les tickers rejetés.
      </p>
      <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
        {typeof onExportCsv === "function" && (
          <button
            type="button"
            className="rounded-lg border border-amber-800/60 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-900/30"
            onClick={onExportCsv}
          >
            Exporter CSV
          </button>
        )}
      </div>
      {summary?.counts && (
        <p className="mt-1 text-[11px] text-amber-200/80">
          {Object.entries(summary.counts)
            .filter(([, n]) => Number(n) > 0)
            .map(([key, n]) => `${summary.labels?.[key] ?? key}: ${n}`)
            .join(" · ")}
        </p>
      )}
      <div className="mt-2 max-h-64 overflow-auto">
        <table className="min-w-full text-[11px] text-amber-50/90">
          <thead>
            <tr className="border-b border-amber-900/40 text-left text-amber-200/70">
              <th className="px-2 py-1">Ticker</th>
              <th className="px-2 py-1">Stage perdu</th>
              <th className="px-2 py-1">Raison</th>
              <th className="px-2 py-1">Universe</th>
              <th className="px-2 py-1">Watchlist</th>
              <th className="px-2 py-1">Yahoo</th>
              <th className="px-2 py-1">Rejet Y.</th>
              <th className="px-2 py-1">Crypto</th>
              <th className="px-2 py-1">OTM</th>
              <th className="px-2 py-1">Commentaire</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className="border-b border-amber-950/50">
                <td className="px-2 py-1 font-medium">{row.ticker}</td>
                <td className="px-2 py-1">{row.stageLost ?? "—"}</td>
                <td className="px-2 py-1">{row.reason ?? "—"}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(row.wasInUniverse)}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(row.wasInWatchlist)}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(row.sentYahoo)}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(row.rejectedYahoo)}</td>
                <td className="px-2 py-1">{formatPipelineYesNo(!row.cryptoBlocked)}</td>
                <td className="px-2 py-1">{row.otmProbeStatus ?? "—"}</td>
                <td className="px-2 py-1 text-amber-100/70">{row.comment ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

// ─── Page Ticker / Analyse titre (lecture seule) ───
// Construit des lignes d'affichage à partir d'un objet déjà présent en mémoire
// (carte finale, ligne IBKR, candidat Yahoo ou ligne de rejet). N'invente aucun
// champ : chaque ligne n'est ajoutée que si la valeur existe réellement.
function buildTickerSummaryRows(obj) {
  if (!obj || typeof obj !== "object") return { symbol: null, rows: [] };
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const up = (v) => String(v ?? "").trim().toUpperCase();
  const symbol = up(obj.ticker ?? obj.symbol) || null;
  const rows = [];
  const push = (label, value) => {
    if (value === null || value === undefined || value === "") return;
    rows.push({ label, value });
  };

  const name = obj.name && up(obj.name) !== symbol ? obj.name : null;
  push("Nom / sous-jacent", name);

  const price = num(
    obj.price ?? obj.currentPrice ?? obj.underlyingPrice ?? obj.lastPrice ?? obj.last
  );
  push("Prix actuel", price != null ? `${price.toFixed(2)}` : null);

  const actionable =
    typeof obj.ok === "boolean"
      ? obj.ok
      : typeof obj.passesFilter === "boolean"
      ? obj.passesFilter
      : typeof obj.dataTradable === "boolean"
      ? obj.dataTradable
      : null;
  push("Statut", actionable === null ? null : actionable ? "Actionnable" : "Non actionnable");

  const grade =
    obj.finalDisplayGrade ?? obj.displayGrade ?? obj.recommendedGrade ?? obj.grade ?? null;
  push("Grade final", grade);

  const safeStrike = num(obj.safeStrike?.strike);
  push("SAFE strike", safeStrike != null ? `${safeStrike.toFixed(2)}` : null);
  const aggStrike = num(obj.aggressiveStrike?.strike);
  push("AGGRESSIVE strike", aggStrike != null ? `${aggStrike.toFixed(2)}` : null);

  const safeYield = num(obj.safeStrike?.weeklyYield);
  push("Rendement SAFE", safeYield != null ? `${safeYield.toFixed(2)}%` : null);
  const aggYield = num(obj.aggressiveStrike?.weeklyYield);
  push("Rendement AGGRESSIVE", aggYield != null ? `${aggYield.toFixed(2)}%` : null);

  const pop = num(
    obj.safeStrike?.popProfitEstimated ??
      obj.safeStrike?.popEstimate ??
      obj.popProfitEstimated ??
      obj.popEstimate
  );
  push("POP (SAFE)", pop != null ? `${(pop * 100).toFixed(0)}%` : null);

  const expiration = obj.targetExpiration ?? obj.expiration ?? null;
  push("Expiration utilisée", expiration);

  const reason =
    obj.recommendedReason ?? obj.rejectionReason ?? obj.reason ?? obj.note ?? null;
  push("Raison / diagnostic", reason);

  return { symbol, rows };
}

// ─── Fiche décisionnelle Ticker (habillage UI uniquement) ────────────────────
// Réutilise STRICTEMENT les mêmes champs/priorités que buildTickerSummaryRows :
// aucune nouvelle logique de données, aucune valeur inventée. Les champs absents
// restent à null et sont rendus "—". Sert à présenter le résumé brut sous forme
// de fiche SAFE / AGRESSIF / Diagnostic au lieu d'une table plate.
function buildTickerDecision(obj) {
  if (!obj || typeof obj !== "object") return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const up = (v) => String(v ?? "").trim().toUpperCase();
  const symbol = up(obj.ticker ?? obj.symbol) || null;
  const name = obj.name && up(obj.name) !== symbol ? obj.name : null;
  const price = num(
    obj.price ?? obj.currentPrice ?? obj.underlyingPrice ?? obj.lastPrice ?? obj.last
  );
  const actionable =
    typeof obj.ok === "boolean"
      ? obj.ok
      : typeof obj.passesFilter === "boolean"
      ? obj.passesFilter
      : typeof obj.dataTradable === "boolean"
      ? obj.dataTradable
      : null;
  const grade =
    obj.finalDisplayGrade ?? obj.displayGrade ?? obj.recommendedGrade ?? obj.grade ?? null;
  const expiration = obj.targetExpiration ?? obj.expiration ?? null;
  const reason =
    obj.recommendedReason ?? obj.rejectionReason ?? obj.reason ?? obj.note ?? null;
  const safe = {
    strike: num(obj.safeStrike?.strike),
    weeklyYield: num(obj.safeStrike?.weeklyYield),
    pop: num(
      obj.safeStrike?.popProfitEstimated ??
        obj.safeStrike?.popEstimate ??
        obj.popProfitEstimated ??
        obj.popEstimate
    ),
  };
  const aggressive = {
    strike: num(obj.aggressiveStrike?.strike),
    weeklyYield: num(obj.aggressiveStrike?.weeklyYield),
    // POP agressive : seulement si réellement fournie (jamais déduite de SAFE).
    pop: num(obj.aggressiveStrike?.popProfitEstimated ?? obj.aggressiveStrike?.popEstimate),
  };
  return { symbol, name, price, actionable, grade, expiration, reason, safe, aggressive };
}

// Formatage cohérent avec buildTickerSummaryRows : rendement déjà en %, POP en décimale.
const fmtTickerMoney = (n) => (n != null ? `${n.toFixed(2)}` : "—");
const fmtTickerPct = (n) => (n != null ? `${n.toFixed(2)} %` : "—");
const fmtTickerPop = (n) => (n != null ? `${(n * 100).toFixed(0)} %` : "—");

const TICKER_BADGE_TONES = {
  green: "border-emerald-700/60 bg-emerald-900/40 text-emerald-200",
  cyan: "border-sky-700/60 bg-sky-900/50 text-sky-100",
  amber: "border-amber-700/60 bg-amber-900/30 text-amber-200",
  red: "border-rose-800/60 bg-rose-950/50 text-rose-200",
  gray: "border-slate-700 bg-slate-800/60 text-slate-300",
};

function TickerBadge({ tone = "gray", children }) {
  return (
    <span
      className={
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-medium " +
        (TICKER_BADGE_TONES[tone] || TICKER_BADGE_TONES.gray)
      }
    >
      {children}
    </span>
  );
}

// Bloc SAFE ou AGRESSIF. Garde toujours le bloc visible : si le strike manque,
// affiche un message explicite plutôt que de masquer la donnée.
function TickerStrikeBlock({ kind, data }) {
  const isSafe = kind === "safe";
  const Icon = isSafe ? ShieldCheck : AlertTriangle;
  const accent = isSafe
    ? { border: "border-emerald-800/50", text: "text-emerald-300" }
    : { border: "border-amber-800/50", text: "text-amber-300" };
  const hasStrike = data.strike != null;
  return (
    <div className={"rounded-xl border bg-slate-950/50 p-3 " + accent.border}>
      <div className="flex items-center gap-1.5">
        <Icon className={"h-4 w-4 " + accent.text} />
        <p className={"text-[11px] font-semibold uppercase tracking-wide " + accent.text}>
          {isSafe ? "SAFE" : "Agressif"}
        </p>
      </div>
      {hasStrike ? (
        <dl className="mt-2 space-y-1">
          <div className="flex items-center justify-between gap-3">
            <dt className="text-xs text-slate-500">Strike</dt>
            <dd className="text-sm font-semibold text-slate-100">{fmtTickerMoney(data.strike)}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-xs text-slate-500">Rendement</dt>
            <dd className="text-sm font-medium text-slate-100">{fmtTickerPct(data.weeklyYield)}</dd>
          </div>
          <div className="flex items-center justify-between gap-3">
            <dt className="text-xs text-slate-500">POP</dt>
            <dd className="text-sm font-medium text-slate-100">{fmtTickerPop(data.pop)}</dd>
          </div>
        </dl>
      ) : (
        <p className="mt-2 text-xs text-slate-500">Non disponible dans le dernier scan.</p>
      )}
    </div>
  );
}

// Fiche décisionnelle réutilisable (résumé du scan + résultat de scan individuel).
function TickerDecisionCard({ decision, source, heading, statusLabel, statusTone, rawObj }) {
  const status =
    statusLabel != null
      ? { label: statusLabel, tone: statusTone || "gray" }
      : decision.actionable === true
      ? { label: "Actionnable", tone: "green" }
      : decision.actionable === false
      ? { label: "Non actionnable", tone: "red" }
      : { label: "Statut inconnu", tone: "gray" };
  // Fallback brut repliable (étape 8) : garantit qu'aucune donnée ne disparaît.
  const fallback = rawObj ? buildTickerSummaryRows(rawObj) : { rows: [] };
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {heading && <p className="text-xs uppercase tracking-wide text-slate-500">{heading}</p>}
          <h2 className="mt-1 text-xl font-semibold text-slate-50">{decision.symbol ?? "—"}</h2>
          {decision.name && <p className="text-xs text-slate-400">{decision.name}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <TickerBadge tone={status.tone}>{status.label}</TickerBadge>
          {decision.grade && <TickerBadge tone="cyan">Grade {decision.grade}</TickerBadge>}
          {source && <TickerBadge tone="gray">Source : {source}</TickerBadge>}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
        <div className="flex items-center gap-2">
          <span className="text-slate-500">Prix actuel</span>
          <span className="font-semibold text-slate-100">{fmtTickerMoney(decision.price)}</span>
        </div>
        <div className="flex items-center gap-2">
          <CalendarDays className="h-3.5 w-3.5 text-slate-500" />
          <span className="text-slate-500">Expiration</span>
          <span className="font-medium text-slate-100">{decision.expiration ?? "—"}</span>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TickerStrikeBlock kind="safe" data={decision.safe} />
        <TickerStrikeBlock kind="aggressive" data={decision.aggressive} />
      </div>

      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <div className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-sky-300" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-sky-300">Diagnostic</p>
        </div>
        <p
          className="mt-1.5 text-sm text-slate-200"
          title={decision.reason && translateTickerReason(decision.reason) !== decision.reason ? decision.reason : undefined}
        >
          {decision.reason
            ? translateTickerReason(decision.reason)
            : "Aucun diagnostic détaillé disponible dans le dernier scan."}
        </p>
      </div>

      {fallback.rows.length > 0 && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">
            Données brutes du dernier scan
          </summary>
          <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
            {fallback.rows.map((row) => (
              <div
                key={row.label}
                className="flex items-center justify-between gap-3 border-b border-slate-800/70 py-1"
              >
                <dt className="text-xs text-slate-500">{row.label}</dt>
                <dd className="text-right text-xs font-medium text-slate-300">{row.value}</dd>
              </div>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

// ─── Traduction UI des raisons techniques (page Ticker uniquement) ─────────────
// Pur affichage : ne modifie jamais les codes dans le state ni les données brutes.
function translateTickerReasonCode(code) {
  const TICKER_REASON_TRANSLATIONS = {
    absent_from_strict_watchlist_after_rebuild: "Absent de la watchlist stricte après rebuild",
    above_max_price: "Prix au-dessus du maximum autorisé",
    market_cap_below_min: "Capitalisation trop faible",
    below_min_price: "Prix sous le minimum autorisé",
    price_unavailable: "Prix indisponible",
    below_score_floor: "Score sous le seuil minimal",
    below_min_volume: "Volume sous le minimum requis",
    crypto_blocked_except_bitx: "Crypto bloqué — seul BITX est autorisé",
    expiration_not_available: "Expiration non disponible",
    failed_final_filter: "Échec du filtre final",
    no_put_below_lower_bound: "Aucun put disponible sous la borne basse",
    no_liquid_strike_below_lower_bound: "Aucun strike liquide sous la borne basse",
    premium_below_target: "Prime sous la cible minimale",
    yield_below_target: "Rendement sous la cible minimale",
    safe_strike_not_liquid: "Strike SAFE insuffisamment liquide",
    ibkr_rejected: "Rejeté par IBKR",
    not_sent_to_ibkr: "Non envoyé à IBKR",
    not_tested: "Non testé",
    not_found: "Non trouvé",
    unknown: "Inconnu",
    excluded_by_watchlist_limit: "Exclu par la limite de la watchlist",
    watchlist_rebuild: "Coupé au rebuild de la watchlist",
    pool_pre_scan: "Coupé avant le scan",
    yahoo_returned: "Retourné par Yahoo",
    ibkr_retained: "Retenu par IBKR",
    ibkr_rejected_spread: "Rejeté par IBKR — spread trop large",
    spread_too_wide: "Spread trop large",
    no_valid_safe_strike: "Aucun strike SAFE valide",
    no_valid_aggressive_strike: "Aucun strike AGRESSIF valide",
    insufficient_premium: "Prime insuffisante",
    insufficient_yield: "Rendement insuffisant",
  };
  const t = String(code ?? "").trim();
  if (!t) return "—";
  if (TICKER_REASON_TRANSLATIONS[t]) return TICKER_REASON_TRANSLATIONS[t];
  const ibkrLabel = formatIbkrReason(t);
  if (ibkrLabel !== t.replaceAll("_", " ")) return ibkrLabel;
  return t.replaceAll("_", " ");
}

function translateTickerReason(reason) {
  if (reason == null || reason === "") return "—";
  const s = String(reason).trim();
  if (!s) return "—";

  if (/^(SAFE|AGGRESSIVE|AGRESSIF|REJECT|WATCH)\s*—/i.test(s)) return s;
  if (/[àâäéèêëïîôùûüçÀÂÄÉÈÊËÏÎÔÙÛÜÇ]/.test(s)) return s;
  if (!s.includes("_") && /\s/.test(s) && !/^[a-z0-9_]+$/i.test(s)) return s;

  const prefixed = s.match(/^(IBKR|Yahoo)\s*—\s*(.+)$/i);
  if (prefixed) return `${prefixed[1]} — ${translateTickerReasonPart(prefixed[2])}`;

  return translateTickerReasonPart(s);
}

function translateTickerReasonPart(part) {
  const p = String(part ?? "").trim();
  if (!p) return "—";
  if (p.includes(": ")) {
    return p
      .split(": ")
      .map((seg) => translateTickerReasonCode(seg.trim()))
      .join(" : ");
  }
  if (/^[a-z][a-z0-9_]*$/i.test(p) && (p.includes("_") || p === "unknown")) {
    return translateTickerReasonCode(p);
  }
  if (p.includes("_")) return translateTickerReasonCode(p);
  return p;
}

// ─── Diagnostic pipeline Ticker (présentation compacte) ──────────────────────
// Mappe le diagnostic pipeline riche (buildTickerPipelineDiagnostic, flat booleans)
// en étapes compactes pour la fiche Ticker. Pur, sans effet de bord, jamais throw.
// N'invente aucune donnée : tout champ absent => "Inconnu" / status "unknown".
const TICKER_PIPELINE_STAGE_TONE = {
  ok: "border-emerald-700/60 bg-emerald-900/30 text-emerald-200",
  warning: "border-amber-700/60 bg-amber-900/30 text-amber-200",
  fail: "border-rose-800/60 bg-rose-950/50 text-rose-200",
  unknown: "border-slate-700 bg-slate-800/60 text-slate-400",
};
const TICKER_PIPELINE_CONFIDENCE_LABEL = {
  high: "élevée",
  medium: "moyenne",
  low: "faible",
  unknown: "indéterminée",
};

function buildTickerPipelineStages(diagnostic, extras = {}) {
  const d = diagnostic || {};
  const scanLoaded = extras.scanLoaded !== false;
  const inPreScanPool = extras.inPreScanPool === true;
  const inScan = extras.inScan === true;
  const unknownStage = (key, label) => ({
    key,
    label,
    status: "unknown",
    value: "Inconnu",
    detail: "Donnée non disponible — aucun scan chargé.",
  });

  // 1. Dernier scan
  let scan;
  if (!scanLoaded) {
    scan = unknownStage("scan", "Dernier scan");
  } else if (inScan) {
    scan = {
      key: "scan",
      label: "Dernier scan",
      status: "ok",
      value: "Présent",
      detail: inPreScanPool
        ? "Présent dans le pool pré-scan."
        : "Présent dans les données du dernier scan.",
    };
  } else {
    scan = {
      key: "scan",
      label: "Dernier scan",
      status: "fail",
      value: "Absent",
      detail: d.preScanAbsentReason || d.cryptoBlockReason || "Absent du pool scanné au dernier refresh.",
    };
  }

  // 2. Yahoo
  let yahoo;
  if (!scanLoaded) {
    yahoo = unknownStage("yahoo", "Yahoo");
  } else if (d.presentInYahoo) {
    const detail =
      [d.yahooRank != null ? `rang ${d.yahooRank}` : null, d.yahooStatus]
        .filter(Boolean)
        .join(" · ") || "Retenu par le scan Yahoo.";
    yahoo = { key: "yahoo", label: "Yahoo", status: "ok", value: "Retenu", detail };
  } else if (d.yahooRejectReason) {
    yahoo = { key: "yahoo", label: "Yahoo", status: "fail", value: "Rejeté", detail: d.yahooRejectReason };
  } else {
    yahoo = {
      key: "yahoo",
      label: "Yahoo",
      status: inScan ? "warning" : "unknown",
      value: inScan ? "Non retenu" : "Non trouvé",
      detail: inScan
        ? "Présent au scan mais pas dans la shortlist Yahoo."
        : "Aucune trace dans le retour Yahoo.",
    };
  }

  // 3. Pré-IBKR (envoyé / coupé)
  let preIbkr;
  if (!scanLoaded) {
    preIbkr = unknownStage("preIbkr", "Pré-IBKR");
  } else if (d.sentToIbkr) {
    preIbkr = {
      key: "preIbkr",
      label: "Pré-IBKR",
      status: "ok",
      value: "Envoyé à IBKR",
      detail: "Transmis au scan IBKR auto.",
    };
  } else if (d.presentInYahoo) {
    preIbkr = {
      key: "preIbkr",
      label: "Pré-IBKR",
      status: "warning",
      value: "Non envoyé",
      detail: "Retenu Yahoo mais non envoyé (cap Audit Depth, priorité ou scan IBKR non lancé).",
    };
  } else {
    preIbkr = {
      key: "preIbkr",
      label: "Pré-IBKR",
      status: "fail",
      value: "Coupé",
      detail:
        d.yahooRejectReason || d.preScanAbsentReason || d.cryptoBlockReason || "Coupé avant l'étape IBKR.",
    };
  }

  // 4. IBKR (testé / retenu / rejeté)
  let ibkr;
  if (!scanLoaded) {
    ibkr = unknownStage("ibkr", "IBKR");
  } else if (d.presentInIbkrShortlist) {
    ibkr = { key: "ibkr", label: "IBKR", status: "ok", value: "Testé / retenu", detail: "Validé par le scan IBKR." };
  } else if (d.presentInIbkrRejected) {
    ibkr = {
      key: "ibkr",
      label: "IBKR",
      status: "fail",
      value: "Testé / rejeté",
      detail: d.ibkrRejectReason || "Rejeté par IBKR (pas de jambe safe/aggressive valide).",
    };
  } else if (d.sentToIbkr || d.ibkrTested) {
    ibkr = {
      key: "ibkr",
      label: "IBKR",
      status: "warning",
      value: "Testé / sans résultat",
      detail: "Envoyé à IBKR mais ni retenu ni rejeté enregistré.",
    };
  } else {
    ibkr = {
      key: "ibkr",
      label: "IBKR",
      status: "warning",
      value: "Non testé",
      detail: "Pas envoyé au scan IBKR.",
    };
  }

  // 5. Cartes finales
  let finalCards;
  if (!scanLoaded) {
    finalCards = unknownStage("finalCards", "Cartes finales");
  } else if (d.presentInFilteredCards) {
    finalCards = {
      key: "finalCards",
      label: "Cartes finales",
      status: "ok",
      value: "Oui",
      detail: d.finalStatus ? `Affiché — ${d.finalStatus}.` : "Présent dans les cartes affichées.",
    };
  } else if (d.presentInEnriched || d.presentInBackendCandidates) {
    finalCards = {
      key: "finalCards",
      label: "Cartes finales",
      status: "warning",
      value: "Non (filtré)",
      detail: d.likelyReason || "Présent en amont mais masqué par un filtre / tri UI.",
    };
  } else {
    finalCards = {
      key: "finalCards",
      label: "Cartes finales",
      status: "fail",
      value: "Non",
      detail: "Absent des cartes finales du scan courant.",
    };
  }

  // 6. Combo pool
  let comboPool;
  if (!scanLoaded) {
    comboPool = unknownStage("comboPool", "Combo pool");
  } else if (d.presentInComboPool) {
    comboPool = {
      key: "comboPool",
      label: "Combo pool",
      status: "ok",
      value: "Oui",
      detail: "Éligible au pool de combinaisons capital.",
    };
  } else if (d.presentInFilteredCards) {
    comboPool = {
      key: "comboPool",
      label: "Combo pool",
      status: "warning",
      value: "Non",
      detail: d.likelyReason || "Carte visible mais non éligible au combo pool.",
    };
  } else {
    comboPool = {
      key: "comboPool",
      label: "Combo pool",
      status: "unknown",
      value: "Non",
      detail: "Hors cartes finales — combo pool non applicable.",
    };
  }

  const stages = [scan, yahoo, preIbkr, ibkr, finalCards, comboPool];

  // Raison principale — priorité : IBKR rejet → crypto → coupure pré-IBKR → Yahoo → fiche → probable.
  let mainReason;
  if (d.presentInIbkrRejected && d.ibkrRejectReason) mainReason = `IBKR — ${d.ibkrRejectReason}`;
  else if (d.cryptoBlockReason) mainReason = d.cryptoBlockReason;
  else if (!inPreScanPool && d.preScanAbsentReason) mainReason = d.preScanAbsentReason;
  else if (!d.presentInYahoo && d.yahooRejectReason) mainReason = `Yahoo — ${d.yahooRejectReason}`;
  else if (extras.decisionReason) mainReason = extras.decisionReason;
  else if (d.likelyReason) mainReason = d.likelyReason;
  else mainReason = "Aucune raison détaillée disponible.";

  let confidence;
  if (!scanLoaded) confidence = "unknown";
  else if (d.presentInIbkrShortlist || d.presentInFilteredCards) confidence = "high";
  else if (inScan) confidence = "medium";
  else confidence = "low";

  const sourcesDetected = {
    finalCards: Boolean(d.presentInFilteredCards),
    yahoo: Boolean(d.presentInYahoo),
    ibkr: Boolean(d.presentInIbkrShortlist),
    rejected: Boolean(d.presentInIbkrRejected),
    comboPool: Boolean(d.presentInComboPool),
  };

  return { stages, mainReason, confidence, sourcesDetected };
}

// Carte UI compacte "Diagnostic pipeline" pour la page Ticker (lecture seule).
function TickerPipelineStagesCard({ view, symbol }) {
  if (!view) return null;
  if (!view.available) {
    return (
      <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-sm" data-testid="ticker-pipeline-stages">
        <div className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-cyan-300" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">Diagnostic pipeline</p>
        </div>
        <p className="mt-2 text-sm text-slate-400">
          Diagnostic pipeline indisponible — {symbol} absent des données chargées.
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Lance un scan pour reconstruire le chemin pipeline de ce ticker.
        </p>
      </div>
    );
  }
  const { stages = [], mainReason, confidence, sourcesDetected } = view;
  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-sm" data-testid="ticker-pipeline-stages">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Activity className="h-4 w-4 text-cyan-300" />
          <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-300">Diagnostic pipeline</p>
        </div>
        {confidence && (
          <span className="text-[10px] text-slate-500">
            Confiance : {TICKER_PIPELINE_CONFIDENCE_LABEL[confidence] || confidence}
          </span>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-400">
        Chemin du ticker dans le dernier scan : Yahoo → pré-IBKR → IBKR → affichage final.
      </p>

      <dl className="mt-3 space-y-0.5">
        {stages.map((stage) => (
          <div
            key={stage.key}
            className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-slate-800/70 py-1.5"
          >
            <div className="min-w-0">
              <dt className="text-sm text-slate-200">{stage.label}</dt>
              {stage.detail && (
                <p
                  className="text-[11px] text-slate-500"
                  title={
                    translateTickerReason(stage.detail) !== stage.detail ? stage.detail : undefined
                  }
                >
                  {translateTickerReason(stage.detail)}
                </p>
              )}
            </div>
            <dd className="shrink-0">
              <span
                className={
                  "inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium " +
                  (TICKER_PIPELINE_STAGE_TONE[stage.status] || TICKER_PIPELINE_STAGE_TONE.unknown)
                }
              >
                {stage.value}
              </span>
            </dd>
          </div>
        ))}
      </dl>

      <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Raison principale</p>
        <p
          className="mt-1 text-sm text-slate-200"
          title={
            mainReason && translateTickerReason(mainReason) !== mainReason ? mainReason : undefined
          }
        >
          {mainReason ? translateTickerReason(mainReason) : "Aucune raison détaillée disponible."}
        </p>
      </div>

      {sourcesDetected && (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-slate-500 hover:text-slate-300">Sources détectées</summary>
          <ul className="mt-2 grid grid-cols-1 gap-y-0.5 text-[11px] text-slate-400 sm:grid-cols-2">
            <li>Cartes finales : {sourcesDetected.finalCards ? "oui" : "non"}</li>
            <li>Yahoo : {sourcesDetected.yahoo ? "oui" : "non"}</li>
            <li>IBKR retenu : {sourcesDetected.ibkr ? "oui" : "non"}</li>
            <li>IBKR rejeté : {sourcesDetected.rejected ? "oui" : "non"}</li>
            <li>Combo pool : {sourcesDetected.comboPool ? "oui" : "non"}</li>
          </ul>
        </details>
      )}
    </div>
  );
}

// ─── Sidebar de navigation (habillage UI uniquement — aucune logique métier) ───
// Phase 1 : navigation par changement de vue (Opportunités / Saisonnalité / Journal POP)
// + ancrages scrollIntoView vers les sections existantes du dashboard.
const SIDEBAR_ITEMS = [
  { key: "opportunites", label: "Opportunités", icon: Target, view: "dashboard", anchor: "section-opportunites" },
  { key: "scan", label: "Scan", icon: RefreshCw, view: "dashboard", anchor: "section-scan" },
  { key: "portefeuille", label: "Portefeuille", icon: PieChart, view: "dashboard", anchor: "section-portefeuille" },
  { key: "ticker", label: "Ticker", icon: Search, view: "ticker" },
  { key: "diagnostics", label: "Diagnostics", icon: Activity, view: "diagnostics" },
  { key: "saisonnalite", label: "Saisonnalité", icon: CalendarDays, view: "seasonality" },
  { key: "journal", label: "Journal POP", icon: Database, view: "journal" },
];
const SIDEBAR_FOOTER_ITEMS = [
  { key: "parametres", label: "Paramètres", icon: Settings, view: "dashboard", anchor: "section-scan" },
  { key: "systeme", label: "Système", icon: Server, view: "dashboard", anchor: "section-diagnostics" },
];

function SidebarButton({ item, active, onClick }) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      title={item.label}
      className={
        "flex w-[64px] flex-col items-center justify-center gap-1 rounded-xl px-1 py-2 text-[10px] leading-tight transition-colors " +
        (active
          ? "border border-sky-700/60 bg-sky-900/60 text-sky-100"
          : "border border-transparent text-slate-400 hover:bg-slate-800/70 hover:text-slate-100")
      }
    >
      <Icon className="h-4 w-4" />
      <span className="text-center">{item.label}</span>
    </button>
  );
}

function WheelSidebar({ activeView, onNavigate }) {
  const isActive = (item) => {
    if (item.view === "seasonality") return activeView === "seasonality";
    if (item.view === "journal") return activeView === "journal";
    if (item.view === "diagnostics") return activeView === "diagnostics";
    if (item.view === "ticker") return activeView === "ticker";
    if (item.key === "opportunites") return activeView === "dashboard";
    return false;
  };
  const isLab =
    typeof window !== "undefined" && window.location.port === "5174";
  return (
    <aside className="sticky top-0 z-30 flex h-screen w-[68px] shrink-0 flex-col items-center border-r border-[rgba(110,150,190,0.16)] bg-[#0a1726] py-3">
      <div className="mb-3 flex flex-col items-center gap-1">
        <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-[rgba(110,150,190,0.30)] bg-[#0d2034] text-[12px] font-bold tracking-tight text-[#cfe0f2]">
          W
        </div>
        <span className="text-[9px] font-semibold uppercase tracking-wide text-[#6f86a6]">
          Wheel
        </span>
      </div>

      <nav className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
        {SIDEBAR_ITEMS.map((item) => (
          <SidebarButton
            key={item.key}
            item={item}
            active={isActive(item)}
            onClick={() => onNavigate(item)}
          />
        ))}
      </nav>

      <div className="mt-auto flex w-full flex-col items-center gap-1 pt-2">
        <div className="my-2 h-px w-8 bg-slate-800" />
        {SIDEBAR_FOOTER_ITEMS.map((item) => (
          <SidebarButton
            key={item.key}
            item={item}
            active={false}
            onClick={() => onNavigate(item)}
          />
        ))}
        <div className="mt-2 flex flex-col items-center gap-1">
          <span className="flex items-center gap-1 text-[9px] font-medium text-emerald-400">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> OK
          </span>
          {isLab && (
            <span
              title="Instance LAB — diagnostics en lecture seule"
              className="rounded border border-[rgba(110,150,190,0.25)] bg-[#0d2034] px-1 py-px text-[7px] font-medium uppercase tracking-wide text-[#6f86a6]"
            >
              lab
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}

// Ordre maquette : barre horizontale premium pour la vue Opportunités.
const TOPNAV_ITEMS = [
  { key: "opportunites", label: "Opportunités", view: "dashboard", anchor: "section-opportunites" },
  { key: "scan", label: "Scan", view: "dashboard", anchor: "section-scan" },
  { key: "portefeuille", label: "Portefeuille", view: "dashboard", anchor: "section-portefeuille" },
  { key: "journal", label: "Journal POP", view: "journal" },
  { key: "diagnostics", label: "Diagnostics", view: "diagnostics" },
  { key: "saisonnalite", label: "Saisonnalité", view: "seasonality" },
  { key: "parametres", label: "Paramètres", view: "dashboard", anchor: "section-scan" },
  { key: "systeme", label: "Système", view: "dashboard", anchor: "section-diagnostics" },
];

// Navigation horizontale (maquette) : remplace la sidebar verticale sur la vue Opportunités.
function WheelTopNav({ activeView, onNavigate }) {
  const isLab =
    typeof window !== "undefined" && window.location.port === "5174";
  const isActive = (item) => {
    if (item.view === "seasonality") return activeView === "seasonality";
    if (item.view === "journal") return activeView === "journal";
    if (item.view === "diagnostics") return activeView === "diagnostics";
    if (item.key === "opportunites") return activeView === "dashboard";
    return false;
  };
  return (
    <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-[rgba(110,150,190,0.16)] bg-[#0a1726] px-4 py-2.5 shadow-[0_6px_24px_rgba(0,0,0,0.35)]">
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-emerald-500/40 bg-emerald-500/10 text-emerald-300">
          <Target className="h-4 w-4" />
        </span>
        <span className="text-sm font-bold tracking-tight text-[#f4f7fb]">WHEEL</span>
      </div>
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {TOPNAV_ITEMS.map((item) => {
          const active = isActive(item);
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item)}
              className={
                "shrink-0 px-3 py-1.5 text-[13px] font-medium transition-colors " +
                (active
                  ? "rounded-t-lg border-b-2 border-emerald-400 text-[#f4f7fb]"
                  : "rounded-lg text-[#7f97b6] hover:text-[#cfe0f2]")
              }
            >
              {item.label}
            </button>
          );
        })}
      </nav>
      <div className="flex shrink-0 items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
          <span className="h-2 w-2 rounded-full bg-emerald-400" /> OK
        </span>
        {isLab && (
          <span
            title="Instance LAB 5174 — diagnostics en lecture seule, aucun ordre envoyé."
            className="rounded border border-[rgba(110,150,190,0.25)] bg-[#0d2034] px-1.5 py-0.5 text-[10px] font-medium text-[#6f86a6]"
          >
            LAB 5174
          </span>
        )}
      </div>
    </header>
  );
}

export default function Dashboard() {
  const readStoredNumber = (key, fallback) => {
    const raw = window.localStorage.getItem(key);
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const readStoredLiquidityOtmProbePct = (key, fallback) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null || raw === "") return fallback;
    const value = Number(String(raw).trim().replace(",", "."));
    if (!Number.isFinite(value) || value < 0 || value > 45) return fallback;
    return LIQUIDITY_OTM_PROBE_PCT_CHOICES.includes(value) ? value : fallback;
  };
  const readStoredAutoJournalMode = () => {
    const raw = String(window.localStorage.getItem("wheel.autoJournalPop") || "off").trim().toLowerCase();
    return raw === "10" || raw === "30" || raw === "50" || raw === "100" || raw === "150" || raw === "200"
      ? raw
      : "off";
  };
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sortBy, setSortBy] = useState("quality");
  const [sortOrder, setSortOrder] = useState("desc");
  const [selectedItem, setSelectedItem] = useState(null);
  const [highlightedTicker, setHighlightedTicker] = useState(null);
  const [activeView, setActiveView] = useState("dashboard");
  const tickerHighlightTimeoutRef = useRef(null);

  // Page "Analyse titre" (activeView === "ticker") — lecture seule, isolée d'Opportunités.
  const [tickerInput, setTickerInput] = useState("");
  const [tickerActive, setTickerActive] = useState("");
  const [tickerScanResult, setTickerScanResult] = useState(null);
  const [tickerScanLoading, setTickerScanLoading] = useState(false);
  const [tickerScanError, setTickerScanError] = useState("");

  const [selectedExpiration, setSelectedExpiration] = useState(() =>
    pickDefaultExpiration(DEFAULT_EXPIRATION_VALUES)
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

  const expirationOptions = useMemo(
    () => buildExpirationOptions(futureExpirations(DEFAULT_EXPIRATIONS)),
    []
  );
  /**
   * Si l'expiration sélectionnée correspond à une option marché fermé (ex. vendredi
   * Juneteenth substitué par le jeudi précédent), on expose la note + l'éventuel blocage.
   */
  const selectedExpirationClosedInfo = useMemo(() => {
    const opt = expirationOptions.find((o) => o.value === selectedExpiration);
    if (!opt || !opt.closed) return null;
    const holidaySuffix = opt.holidayLabel ? ` (${opt.holidayLabel})` : "";
    if (opt.blocked || !opt.adjusted) {
      return {
        blocked: true,
        message: `Expiration fermée${holidaySuffix} : utiliser le jeudi précédent si disponible.`,
      };
    }
    return {
      blocked: false,
      message: `${opt.original} est fermé${holidaySuffix}. Expiration utilisée : ${opt.value}.`,
    };
  }, [expirationOptions, selectedExpiration]);
  const scanBlockedByClosedExpiration = Boolean(selectedExpirationClosedInfo?.blocked);
  const [topN, setTopN] = useState(() => readStoredNumber("wheel.topYahooReturned", 55));
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
  const [watchlistOtmProbePct, setWatchlistOtmProbePct] = useState(() =>
    readStoredLiquidityOtmProbePct(
      "wheel.liquidityOtmProbePct",
      DEFAULT_BUILD_WATCHLIST_BODY.liquidityOtmProbePct
    )
  );
  const [preIbkrPoolMode, setPreIbkrPoolMode] = useState(() =>
    readStoredPreIbkrPoolMode(window.localStorage.getItem("wheel.preIbkrPoolMode"))
  );
  const [researchExpandedLimit, setResearchExpandedLimit] = useState(() =>
    readStoredResearchExpandedLimit(window.localStorage.getItem("wheel.researchExpandedLimit"))
  );
  const [researchExpandedEnabled, setResearchExpandedEnabled] = useState(() => {
    const raw = window.localStorage.getItem("wheel.researchExpandedEnabled");
    if (raw === "false") return false;
    if (raw === "true") return true;
    return readStoredPreIbkrPoolMode(window.localStorage.getItem("wheel.preIbkrPoolMode")) === "research_expanded";
  });
  const [researchExpandedMaxPrice, setResearchExpandedMaxPrice] = useState(() => {
    const raw = window.localStorage.getItem("wheel.researchExpandedMaxPrice");
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? value : null;
  });
  const [researchExpandedIncludeAboveMaxPrice, setResearchExpandedIncludeAboveMaxPrice] = useState(() => {
    const raw = window.localStorage.getItem("wheel.researchExpandedIncludeAboveMaxPrice");
    return raw !== "false";
  });
  const [researchExpandedFlagUnreliable, setResearchExpandedFlagUnreliable] = useState(() => {
    const raw = window.localStorage.getItem("wheel.researchExpandedFlagUnreliable");
    return raw !== "false";
  });
  const [researchExpandedPool, setResearchExpandedPool] = useState([]);
  const [researchExpandedStats, setResearchExpandedStats] = useState(null);
  const [researchExpandedPoolSource, setResearchExpandedPoolSource] = useState("loading");
  const [researchExpandedPoolError, setResearchExpandedPoolError] = useState("");
  const [lastScanPoolMeta, setLastScanPoolMeta] = useState({
    poolSource: "",
    preIbkrCount: 0,
    yahooSent: 0,
    yahooReturned: 0,
    ibkrAuditDepth: 0,
    ibkrTested: 0,
    ibkrRetained: 0,
    journalPopCaptured: 0,
    usedFallbackUltimate: false,
    ibkrAutoLaunched: false,
    ibkrAutoSkipReason: "",
  });
  const [lastJournalPopCaptured, setLastJournalPopCaptured] = useState(0);

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
  const [yahooRejectedBySymbol, setYahooRejectedBySymbol] = useState({});
  const [watchlistRejectedBySymbol, setWatchlistRejectedBySymbol] = useState({});
  const [watchlistRejectedRows, setWatchlistRejectedRows] = useState([]);
  const [watchlistTruncatedSymbols, setWatchlistTruncatedSymbols] = useState([]);
  const [yahooSentToScanCount, setYahooSentToScanCount] = useState(0);
  const [yahooScanErrorCount, setYahooScanErrorCount] = useState(0);
  const [yahooRequestedTopN, setYahooRequestedTopN] = useState(0);
  const [yahooChallengerCount, setYahooChallengerCount] = useState(0);
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
  const [ibkrMemoryRefreshKey, setIbkrMemoryRefreshKey] = useState(0);
  const [ibkrDirectError, setIbkrDirectError] = useState("");
  const [ibkrDirectResult, setIbkrDirectResult] = useState(null);
  const [ibkrDirectSentTickers, setIbkrDirectSentTickers] = useState([]);
  const [yahooScanTiming, setYahooScanTiming] = useState(null);
  const [autoIbkrDirectScan, setAutoIbkrDirectScan] = useState(true);
  const [ibkrAutoMaxTickers, setIbkrAutoMaxTickers] = useState(() =>
    readStoredNumber("wheel.ibkrAuditDepth", 50)
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
    setYahooRejectedBySymbol({});
    setYahooSentToScanCount(0);
    setYahooScanErrorCount(0);
    setYahooRequestedTopN(0);
    setYahooChallengerCount(0);
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

      // Filtre Mode (UI seulement) : compare le mode réellement retenu/affiché par la ligne
      // (SAFE / AGGRESSIVE). BALANCED strike leg future phase — do not expose as line filter
      // until backend provides a real balanced leg.
      const matchesFilter =
        filter === "all"
          ? true
          : getFinalDisplayRecommendation(item)?.finalDisplayMode === filter;

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

  const resolvedPreIbkrPool = useMemo(
    () =>
      resolvePreIbkrTickers({
        watchlistTickers,
        preIbkrPoolMode,
        researchExpandedPool,
        researchExpandedLimit,
        fallbackTickers: FALLBACK_TICKERS,
      }),
    [watchlistTickers, preIbkrPoolMode, researchExpandedPool, researchExpandedLimit]
  );

  const _rawWatchlist = resolvedPreIbkrPool.tickers;
  const cryptoRemovedFromPreIbkrPool = resolvedPreIbkrPool.cryptoRemovedFromPool ?? [];
  const tickersForScan = _rawWatchlist.filter((t) => !isCryptoDigitalAssetBlocked(t));
  const currentPoolCount = useMemo(
    () => getCurrentPoolCount({ resolvedPreIbkrPool, tickersForScan, preIbkrPoolMode }),
    [resolvedPreIbkrPool, tickersForScan, preIbkrPoolMode]
  );
  const lastScanPoolStale = useMemo(
    () => isLastScanPoolStale({ preIbkrPoolMode, lastScanPoolMeta }),
    [preIbkrPoolMode, lastScanPoolMeta]
  );
  const fallbackPoolDiagnosticMessage = useMemo(
    () =>
      buildFallbackPoolDiagnosticMessage({
        preIbkrPoolMode,
        lastScanPoolMeta,
        isStale: lastScanPoolStale,
      }),
    [preIbkrPoolMode, lastScanPoolMeta, lastScanPoolStale]
  );
  const cryptoRemovedFromWatchlistCount = cryptoRemovedFromPreIbkrPool.length;
  const cryptoBlockedRemovedSymbols = useMemo(() => {
    const fromBuild = Array.isArray(watchlistStats?.cryptoBlockedRemovedSymbols)
      ? watchlistStats.cryptoBlockedRemovedSymbols
      : [];
    const fromPreIbkr = cryptoRemovedFromPreIbkrPool;
    return [...new Set([...fromBuild, ...fromPreIbkr].map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))].sort();
  }, [watchlistStats, cryptoRemovedFromPreIbkrPool]);
  const cryptoAllowedRetained = useMemo(() => {
    const fromBuild = Array.isArray(watchlistStats?.cryptoAllowedRetained)
      ? watchlistStats.cryptoAllowedRetained
      : [];
    const fromPool = tickersForScan.filter((t) => USER_PREFS.cryptoAllowed.has(String(t || "").trim().toUpperCase()));
    return [...new Set([...fromBuild, ...fromPool])].sort();
  }, [watchlistStats, tickersForScan]);
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
  const watchlistScannable = yahooScanMeta.scanned || tickersForScan.length || 0;
  const admissibleCremeCount =
    filtered.length -
    filtered.filter((it) => {
      const m = getTickerDisplayMeta(String(it?.ticker ?? "").toUpperCase());
      return m.isCryptoBlocked && !m.isCryptoAllowed;
    }).length;

  /** Bassin Yahoo côté dernier résultat IBKR auto (fallback : compteur courant Yahoo retournés). */
  const ibkrTraceYahooReturnedForFunnel = useMemo(() => {
    if (
      ibkrDirectResult?.ok === true &&
      Number.isFinite(Number(ibkrDirectResult.yahooReturnedPoolSize))
    ) {
      return Number(ibkrDirectResult.yahooReturnedPoolSize);
    }
    return yahooReturnedCount;
  }, [ibkrDirectResult, yahooReturnedCount]);

  const ibkrTraceTopReasonLines = useMemo(() => {
    const rr = ibkrDirectResult?.rejectionReasons;
    if (rr && typeof rr === "object" && Object.keys(rr).length) {
      const sorted = Object.entries(rr)
        .map(([reason, count]) => [String(reason || "").trim() || "unknown", Number(count)])
        .filter(([, n]) => Number.isFinite(n) && n > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      return sorted.map(([reason, n]) => `${formatIbkrReason(reason)} (${n})`);
    }
    const rejectedArr = Array.isArray(ibkrDirectResult?.rejected) ? ibkrDirectResult.rejected : [];
    return aggregateIbkrRejectedReasons(rejectedArr, 10).topLines;
  }, [ibkrDirectResult]);

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
  const pipelineFunnelDiagnostics = useMemo(() => {
    const universeSourceCount = Number(watchlistStats?.sourceCount ?? 0);
    const excludedCrypto = Math.max(
      Number(watchlistStats?.cryptoBlockedRemovedCount ?? 0),
      Number(cryptoRemovedFromWatchlistCount ?? 0)
    );
    const universeMasterActive = Math.max(
      0,
      universeSourceCount > 0 ? universeSourceCount + excludedCrypto : (watchlistTickers?.length ?? 0) + excludedCrypto
    );
    const categoriesSelected = Array.isArray(DEFAULT_BUILD_WATCHLIST_BODY?.categories)
      ? DEFAULT_BUILD_WATCHLIST_BODY.categories.length
      : 0;
    const watchlistKept = Number(watchlistStats?.keptCount ?? watchlistTickers?.length ?? 0);
    const watchlistRejected = Number(watchlistStats?.rejectedCount ?? 0);
    const watchlistLimitApplied = Number(
      watchlistStats?.limitApplied ?? DEFAULT_BUILD_WATCHLIST_BODY?.limit ?? 0
    );
    const watchlistBuildRejections = topCountEntries(watchlistStats?.rejectedByReason, 12);
    const tickersSentToScan = Number(yahooSentToScanCount || yahooScanMeta?.scanned || 0);
    const scanned = Number(yahooScanMeta?.scanned || 0);
    const duplicateRemoved = Math.max(0, tickersSentToScan - scanned);
    const scanFailures = Number(yahooScanErrorCount || 0);
    const reasonCounts = normalizeCountMap(yahooDiagnostics?.rejectionReasonCounts);
    const stageCounts = normalizeCountMap(yahooDiagnostics?.stageRejectCounts);
    const expirationReasonKeys = new Set([
      "expiration_unavailable",
      "expirations_unavailable",
      "chain_unavailable",
      "no_valid_expiration",
      ...Object.keys(reasonCounts).filter((k) => String(k).toLowerCase().includes("expiration")),
    ]);
    const expirationUnavailable = Array.from(expirationReasonKeys).reduce(
      (sum, key) => sum + (Number(reasonCounts[key]) || 0),
      0
    );
    const passesFilterTrue = (yahooReturnedCandidates || []).filter((row) => row?.passesFilter === true).length;
    const keptUnreliable = (yahooReturnedCandidates || []).filter(
      (row) => row?.noYahooLiquidity === true || row?.liquiditySource === "yahoo_unreliable"
    ).length;
    const rejectedTotal = Number(yahooDiagnostics?.rejectedTotal || 0);
    const reasonNoPut = sumCountsByKeys(reasonCounts, ["no_put_below_lower_bound", "no_put_with_bid_below_lower_bound"]);
    const reasonNoLiquid = sumCountsByKeys(reasonCounts, ["no_liquid_strike_below_lower_bound"]);
    const reasonPremium = sumCountsByKeys(reasonCounts, ["premium_below_target"]);
    const reasonYield = sumCountsByKeys(reasonCounts, ["yield_below_target"]);
    const reasonSafeNotLiquid = sumCountsByKeys(reasonCounts, ["safe_strike_not_liquid"]);
    const reasonFailedFinal = Number(stageCounts.failed_final_filter || 0);
    const reasonKnownTotal =
      reasonNoPut + reasonNoLiquid + reasonPremium + reasonYield + reasonSafeNotLiquid + reasonFailedFinal;
    const reasonUnknown = Math.max(0, rejectedTotal - reasonKnownTotal);
    const requestedTopN = Number(yahooRequestedTopN || topN || 0);
    const challengerCount = Number(yahooChallengerCount || 0);
    const returned = Number(yahooReturnedCount || 0);
    const hiddenReturnedCandidates = Math.max(0, returned - requestedTopN);
    const visibleAfterTopN = Number(activeCandidates?.length || 0);
    const q = String(query || "").trim().toLowerCase();
    const matchesQuery = (item) =>
      q === "" ||
      String(item?.ticker || "").toLowerCase().includes(q) ||
      String(item?.name || "").toLowerCase().includes(q);
    const matchesVerdict = (item) =>
      filter === "all" ? true : getFinalDisplayRecommendation(item)?.finalDisplayMode === filter;
    const afterQueryCount = (enrichedCandidates || []).filter((item) => matchesQuery(item)).length;
    const afterVerdictCount = (enrichedCandidates || [])
      .filter((item) => matchesQuery(item) && matchesVerdict(item))
      .length;
    const afterExpirationCount = (enrichedCandidates || [])
      .filter((item) => matchesQuery(item) && matchesVerdict(item) && candidateRowMatchesSelectedExpiration(item, selectedExpiration))
      .length;
    const removedBySearch = Math.max(0, (enrichedCandidates?.length || 0) - afterQueryCount);
    const removedByVerdict = Math.max(0, afterQueryCount - afterVerdictCount);
    const removedByExpiration = Math.max(0, afterVerdictCount - afterExpirationCount);
    const filteredFinalCount = Number(filtered?.length || 0);
    const usableCapital = Number(capital) * (Number(maxCapitalPct) / 100);
    const ibkrRejectedRemoved = (filtered || []).filter((row) =>
      ibkrRejectedSymbols.has(String(row?.ticker || "").trim().toUpperCase())
    ).length;
    const comboBasePoolCount = (filtered || [])
      .filter((row) => !ibkrRejectedSymbols.has(String(row?.ticker || "").trim().toUpperCase()))
      .map((row) => buildCapitalComboCandidate(row, usableCapital))
      .filter((row) => row?._isCapitalComboEligible)
      .length;
    const comboSummaries = Object.fromEntries(
      _INSP_BUCKET_KEYS.map((bucketKey) => [
        bucketKey,
        _inspBucketSummary(bucketKey, combos, filtered, usableCapital, ibkrRejectedSymbols),
      ])
    );
    const usableForSAFE =
      (comboSummaries?.SAFE?.selected?.length || 0) + (comboSummaries?.SAFE?.eligibleNotSelected?.length || 0);
    const usableForBALANCED =
      (comboSummaries?.BALANCED?.selected?.length || 0) +
      (comboSummaries?.BALANCED?.eligibleNotSelected?.length || 0);
    const usableForAGGRESSIVE =
      (comboSummaries?.AGGRESSIVE?.selected?.length || 0) +
      (comboSummaries?.AGGRESSIVE?.eligibleNotSelected?.length || 0);
    const rejectionRows = [
      { reason: "Lower Bound Failure", count: reasonNoPut },
      { reason: "Liquidity Failure", count: reasonNoLiquid },
      { reason: "Premium Failure", count: reasonPremium },
      { reason: "Yield Failure", count: reasonYield },
      { reason: "Safe Strike Not Liquid", count: reasonSafeNotLiquid },
      { reason: "Failed Final Filter", count: reasonFailedFinal },
      { reason: "Expiration Missing", count: expirationUnavailable },
      { reason: "Unknown", count: reasonUnknown },
    ]
      .map((row) => {
        const share = rejectedTotal > 0 ? row.count / rejectedTotal : 0;
        const severity = share >= 0.25 ? "High" : share >= 0.1 ? "Medium" : "Low";
        return { ...row, severity };
      })
      .filter((row) => row.count > 0)
      .sort((a, b) => b.count - a.count);
    const stages = [
      { key: "universe", label: "Universe", count: universeMasterActive },
      { key: "watchlist", label: "Watchlist", count: watchlistKept },
      { key: "yahooSent", label: "Yahoo Sent", count: tickersSentToScan },
      { key: "yahooQualified", label: "Yahoo Qualified", count: passesFilterTrue },
      { key: "yahooReturned", label: "Yahoo Returned", count: returned },
      { key: "uiVisible", label: "UI Visible", count: visibleAfterTopN },
      { key: "filteredFinal", label: "Filtered Final", count: filteredFinalCount },
      { key: "comboPool", label: "Combo Pool", count: comboBasePoolCount },
    ];
    const stageLossRows = stages.slice(1).map((stage, idx) => {
      const prev = stages[idx];
      const lost = Math.max(0, Number(prev.count || 0) - Number(stage.count || 0));
      return {
        from: prev.label,
        to: stage.label,
        before: Number(prev.count || 0),
        after: Number(stage.count || 0),
        lost,
        conversionPct: ratioPct(stage.count, prev.count),
      };
    });
    return {
      universeSourceCount,
      universeMasterActive,
      categoriesSelected,
      excludedCrypto,
      cryptoBlockedRemovedSymbols,
      cryptoAllowedRetained,
      buildExcluded: Number(watchlistStats?.rejectedCount ?? 0),
      watchlistKept,
      watchlistRejected,
      watchlistLimitApplied,
      watchlistBuildRejections,
      tickersSentToScan,
      scanned,
      scanFailures,
      expirationUnavailable,
      duplicateRemoved,
      passesFilterTrue,
      keptUnreliable,
      rejectedTotal,
      reasonBreakdown: {
        no_put_below_lower_bound: reasonNoPut,
        no_liquid_strike_below_lower_bound: reasonNoLiquid,
        premium_below_target: reasonPremium,
        yield_below_target: reasonYield,
        safe_strike_not_liquid: reasonSafeNotLiquid,
        failed_final_filter: reasonFailedFinal,
        unknown: reasonUnknown,
      },
      requestedTopN,
      challengerCount,
      returned,
      hiddenReturnedCandidates,
      visibleAfterTopN,
      removedBySearch,
      removedByVerdict,
      removedByExpiration,
      filteredFinalCount,
      comboBasePoolCount,
      ibkrRejectedRemoved,
      usableForSAFE,
      usableForBALANCED,
      usableForAGGRESSIVE,
      fillRatePct: ratioPct(watchlistKept, universeMasterActive),
      qualificationRatePct: ratioPct(passesFilterTrue, scanned),
      finalComboConversionRatePct: ratioPct(comboBasePoolCount, filteredFinalCount),
      stageLossRows,
      rejectionRows,
      stages,
    };
  }, [
    watchlistStats,
    cryptoRemovedFromWatchlistCount,
    cryptoBlockedRemovedSymbols,
    cryptoAllowedRetained,
    watchlistTickers,
    yahooSentToScanCount,
    yahooScanMeta,
    yahooScanErrorCount,
    yahooDiagnostics,
    yahooReturnedCandidates,
    yahooRequestedTopN,
    yahooChallengerCount,
    topN,
    yahooReturnedCount,
    activeCandidates,
    query,
    filter,
    enrichedCandidates,
    selectedExpiration,
    filtered,
    capital,
    maxCapitalPct,
    ibkrRejectedSymbols,
    combos,
  ]);
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

  const pipelineTickerDiagnosticQuery = useMemo(
    () => normalizeTickerQueryForDiagnostic(query),
    [query]
  );

  const pipelineTickerDiagnostic = useMemo(() => {
    if (!pipelineTickerDiagnosticQuery) return null;
    const sym = pipelineTickerDiagnosticQuery;
    let notDisplayedReason = null;
    if (ibkrKeptSymbols.has(sym) && !ibkrDisplayedSymbols.has(sym)) {
      const retainedRow = ibkrRetainedBySymbol.get(sym);
      const preYahoo = candidateByTickerForPreIbkr.get(sym) ?? null;
      const mergedForReason =
        retainedRow != null
          ? {
              ...(preYahoo || {}),
              ...retainedRow,
              safeStrike: retainedRow?.safeStrike ?? preYahoo?.safeStrike,
              aggressiveStrike: retainedRow?.aggressiveStrike ?? preYahoo?.aggressiveStrike,
              ticker: sym,
            }
          : preYahoo;
      if (mergedForReason) {
        notDisplayedReason = getRetainedNotDisplayedReason(mergedForReason, ibkrDisplayedScoreFloor);
      }
    }
    return buildTickerPipelineDiagnostic(sym, {
      tickersForScan,
      yahooReturnedCandidates,
      yahooDiagnostics,
      yahooRejectedBySymbol,
      watchlistRejectedBySymbol,
      watchlistTickers: watchlistTickers ?? [],
      watchlistTruncatedSymbols,
      researchExpandedPool,
      preIbkrPoolMode,
      cryptoBlockedRemovedSymbols,
      ibkrDirectSentTickers,
      ibkrDirectResult,
      backendCandidates: backendCandidates ?? [],
      enrichedCandidates,
      filtered,
      combos,
      capital: Number(capital),
      maxCapitalPct: Number(maxCapitalPct),
      ibkrRejectedSymbols,
      yahooRankForIbkrBySymbol,
      selectedExpiration,
      filter,
      dataSource,
      topN,
      ibkrAutoMaxTickers,
      notDisplayedReason,
      liquidityOtmProbePctSelected: watchlistOtmProbePct,
      liquidityOtmProbePctApplied: watchlistStats?.liquidityOtmProbePctApplied ?? null,
      scanPoolSource: lastScanPoolMeta.poolSource || preIbkrPoolMode,
      watchlistMode: watchlistStats?.watchlistMode ?? DEFAULT_BUILD_WATCHLIST_BODY.watchlistMode,
    });
  }, [
    pipelineTickerDiagnosticQuery,
    tickersForScan,
    yahooReturnedCandidates,
    yahooDiagnostics,
    yahooRejectedBySymbol,
    watchlistRejectedBySymbol,
    watchlistTickers,
    watchlistTruncatedSymbols,
    researchExpandedPool,
    preIbkrPoolMode,
    cryptoBlockedRemovedSymbols,
    ibkrDirectSentTickers,
    ibkrDirectResult,
    backendCandidates,
    enrichedCandidates,
    filtered,
    combos,
    capital,
    maxCapitalPct,
    ibkrRejectedSymbols,
    yahooRankForIbkrBySymbol,
    selectedExpiration,
    filter,
    dataSource,
    topN,
    ibkrAutoMaxTickers,
    ibkrKeptSymbols,
    ibkrDisplayedSymbols,
    ibkrRetainedBySymbol,
    candidateByTickerForPreIbkr,
    ibkrDisplayedScoreFloor,
    watchlistOtmProbePct,
    watchlistStats,
    lastScanPoolMeta.poolSource,
  ]);

  const liquidityOtmProbePctApplied = watchlistStats?.liquidityOtmProbePctApplied ?? null;
  const otmRebuildRequired = useMemo(
    () => isOtmRebuildRequired(watchlistOtmProbePct, liquidityOtmProbePctApplied),
    [watchlistOtmProbePct, liquidityOtmProbePctApplied]
  );
  const otmRebuildRequiredMessage = useMemo(
    () => (otmRebuildRequired ? buildOtmRebuildRequiredMessage(watchlistOtmProbePct) : null),
    [otmRebuildRequired, watchlistOtmProbePct]
  );
  const otmPoolSourceBannerMessage = useMemo(
    () => buildOtmPoolSourceBannerMessage(lastScanPoolMeta.poolSource || preIbkrPoolMode),
    [lastScanPoolMeta.poolSource, preIbkrPoolMode]
  );

  const preIbkrCutTickerList = useMemo(
    () =>
      buildPreIbkrCutTickerList({
        watchlistTickers: watchlistTickers ?? [],
        watchlistRejectedBySymbol,
        watchlistTruncatedSymbols,
        cryptoBlockedRemovedSymbols,
        tickersForScan,
        yahooRejectedBySymbol,
        yahooReturnedCandidates,
        ibkrDirectSentTickers,
        preIbkrPoolMode,
        researchExpandedPool,
      }),
    [
      watchlistTickers,
      watchlistRejectedBySymbol,
      watchlistTruncatedSymbols,
      cryptoBlockedRemovedSymbols,
      tickersForScan,
      yahooRejectedBySymbol,
      yahooReturnedCandidates,
      ibkrDirectSentTickers,
      preIbkrPoolMode,
      researchExpandedPool,
    ]
  );

  const preIbkrCutSummary = useMemo(
    () => summarizePreIbkrCutByCategory(preIbkrCutTickerList),
    [preIbkrCutTickerList]
  );

  const exportPreIbkrCutCsv = useCallback(() => {
    const header = [
      "ticker",
      "stageLost",
      "reason",
      "wasInUniverse",
      "wasInWatchlist",
      "sentYahoo",
      "rejectedYahoo",
      "cryptoBlocked",
      "otmProbeStatus",
      "comment",
      "category",
    ];
    const escape = (value) => {
      const s = String(value ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const lines = [
      header.join(","),
      ...preIbkrCutTickerList.map((row) =>
        header.map((key) => escape(row[key])).join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `pre-ibkr-cut-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [preIbkrCutTickerList]);

  const yahooIbkrFunnelList = useMemo(
    () =>
      buildYahooIbkrFunnel({
        funnelTopCandidates: watchlistStats?.funnelTopCandidates ?? [],
        watchlistTickers: watchlistTickers ?? [],
        watchlistRejectedBySymbol,
        watchlistTruncatedSymbols,
        cryptoBlockedRemovedSymbols,
        tickersForScan,
        yahooRejectedBySymbol,
        yahooReturnedCandidates,
        ibkrDirectSentTickers,
        ibkrDirectResult,
        preIbkrPoolMode,
        researchExpandedPool,
      }),
    [
      watchlistStats,
      watchlistTickers,
      watchlistRejectedBySymbol,
      watchlistTruncatedSymbols,
      cryptoBlockedRemovedSymbols,
      tickersForScan,
      yahooRejectedBySymbol,
      yahooReturnedCandidates,
      ibkrDirectSentTickers,
      ibkrDirectResult,
      preIbkrPoolMode,
      researchExpandedPool,
    ]
  );

  const yahooIbkrFunnelSummary = useMemo(
    () => summarizeYahooIbkrFunnel(yahooIbkrFunnelList),
    [yahooIbkrFunnelList]
  );

  // Phase 1 — archive funnel best-effort. On miroite les sources funnel dans un
  // ref pour ne PAS dépendre d'un state React fraîchement set au moment de la
  // capture (le ref est rafraîchi à chaque render via useEffect ci-dessous).
  const scanFunnelArchiveSourcesRef = useRef({});
  useEffect(() => {
    scanFunnelArchiveSourcesRef.current = {
      funnelRows: yahooIbkrFunnelList,
      displayedSymbols: Array.from(ibkrDisplayedSymbols || []),
      yahooRejectedBySymbol,
      watchlistRejectedBySymbol,
      cryptoBlockedRemovedSymbols,
      ibkrDirectSentTickers,
      ibkrDirectResult,
      poolSource: lastScanPoolMeta.poolSource || preIbkrPoolMode,
      counts: {
        preIbkrCount: lastScanPoolMeta.preIbkrCount ?? null,
        yahooSentCount: lastScanPoolMeta.yahooSent ?? null,
        yahooReturnedCount: lastScanPoolMeta.yahooReturned ?? null,
        ibkrTestedCount: lastScanPoolMeta.ibkrTested ?? null,
        ibkrRetainedCount: lastScanPoolMeta.ibkrRetained ?? null,
        journalPopCaptured: lastScanPoolMeta.journalPopCaptured ?? null,
      },
    };
  }, [
    yahooIbkrFunnelList,
    ibkrDisplayedSymbols,
    yahooRejectedBySymbol,
    watchlistRejectedBySymbol,
    cryptoBlockedRemovedSymbols,
    ibkrDirectSentTickers,
    ibkrDirectResult,
    lastScanPoolMeta,
    preIbkrPoolMode,
  ]);

  // Best-effort : construit le payload compact depuis le ref + champs locaux du
  // scan, puis poste l'archive sans bloquer ni throw. Déféré au prochain tick
  // pour laisser la dérivation du funnel se stabiliser (même pattern que
  // logScanDisplayResult).
  const archiveScanFunnel = useCallback(({ scanSessionId, scanTimestamp, captureSource, sourceOverrides } = {}) => {
    if (!scanSessionId) return;
    setTimeout(() => {
      try {
        const sources = {
          ...(scanFunnelArchiveSourcesRef.current || {}),
          ...(sourceOverrides && typeof sourceOverrides === "object" ? sourceOverrides : {}),
        };
        const selectedExpiration = normalizeExpirationYmd(selectedExpirationRef.current);
        const ts = scanTimestamp ?? new Date().toISOString();
        const hasFunnel = Array.isArray(sources.funnelRows) && sources.funnelRows.length > 0;
        const payload = buildScanFunnelArchivePayload({
          ...sources,
          scanSessionId,
          scanTimestamp: ts,
          selectedExpiration,
          dteAtScan: computeDteAtScan(ts, selectedExpiration),
          captureSource,
          metadata: {
            archiveComplete: hasFunnel,
            ...(hasFunnel ? {} : { reason: "funnel_sources_unavailable_at_capture" }),
          },
        });
        callScanFunnelArchive(payload);
      } catch (error) {
        console.warn("[SCAN_FUNNEL_ARCHIVE_WARN]", {
          scanSessionId,
          error: error?.message || String(error),
        });
      }
    }, 0);
  }, []);

  const exportYahooIbkrFunnelCsv = useCallback(() => {
    const header = [
      "ticker",
      "yahooRank",
      "yahooScore",
      "inTop250",
      "inShortlist",
      "sentIbkr",
      "testedIbkr",
      "ibkrStatus",
      "stageLost",
      "reason",
    ];
    const escape = (value) => {
      const s = String(value ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const lines = [
      header.join(","),
      ...yahooIbkrFunnelList.map((row) =>
        header.map((key) => escape(row[key])).join(",")
      ),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `funnel-yahoo-ibkr-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [yahooIbkrFunnelList]);

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
      // Slice to captureTopN AFTER filtering so Top N means N *admissible* candidates.
      const rawCount = Array.isArray(candidates) ? candidates.length : 0;
      const finalCandidates = (Array.isArray(candidates) ? candidates : [])
        .filter((c) => {
          const sym = String(c?.ticker || "").trim().toUpperCase();
          if (sym && ibkrRejectedSymbols.has(sym)) return false;
          if (!candidateRowMatchesSelectedExpiration(c, selectedExpiration)) return false;
          return true;
        })
        .slice(0, captureTopN);

      const compactCandidates = finalCandidates.map(buildAutoJournalCandidatePayload);
      const approxPayloadKb = Math.round(
        JSON.stringify({ candidates: compactCandidates }).length / 1024
      );

      console.info("[AUTO_JOURNAL_CAPTURE_ATTEMPT]", {
        scanSessionId,
        autoJournalPop,
        captureTopN,
        rawCandidates: rawCount,
        compactCandidates: compactCandidates.length,
        approxPayloadKb,
        ibkrRejectedCount: ibkrRejectedSymbols.size,
        selectedExpiration,
        source,
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
          candidates: compactCandidates,
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
          inserted: payload?.captured ?? null,
          skipped: payload?.skipped ?? null,
          duplicates: payload?.duplicates ?? null,
          skippedReasons: payload?.skippedReasons ?? null,
          sampleSkipped: payload?.sampleSkipped ?? null,
          candidatesSent: compactCandidates.length,
          approxPayloadKb,
          totalReceived: Array.isArray(payload?.journal?.records) ? payload.journal.records.length : null,
          backendTotal: payload?.totalRecords ?? payload?.journal?.totalRecords ?? null,
        });
        const capturedCount = Number(payload?.captured ?? payload?.inserted ?? 0);
        if (Number.isFinite(capturedCount) && capturedCount >= 0) {
          setLastJournalPopCaptured(capturedCount);
          setLastScanPoolMeta((prev) => ({
            ...prev,
            journalPopCaptured: capturedCount,
          }));
        }
        return payload;
      } catch (error) {
        console.warn("[AUTO_JOURNAL_ERROR]", {
          scanSessionId,
          source,
          captureTopN,
          status: error?.status ?? null,
          statusText: error?.statusText ?? null,
          responseText: error?.responseText ?? null,
          payloadKb: error?.payloadKb ?? approxPayloadKb,
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

      if (ibkrAutoInput.poolSource === "research_expanded") {
        candidatePool = applyResearchExpandedPinnedTickers(candidatePool, hardEvaluationCap);
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
        // Gros lots IBKR (défaut 50) au lieu de 10 puis 5+5+5 : 1 lot pour Depth <= 50.
        const ibkrScanBatchSize = await fetchIbkrScanBatchSize();
        console.log("[IBKR BATCHING][UI]", {
          totalTickers: Math.min(candidatePool.length, hardEvaluationCap),
          batchSize: ibkrScanBatchSize,
          batchCount: Math.max(
            1,
            Math.ceil(Math.min(candidatePool.length, hardEvaluationCap) / ibkrScanBatchSize)
          ),
          requestedDepth: finalTarget,
        });
        let cursor = 0;
        while (cursor < hardEvaluationCap && retainedSymbols.size < desiredFinalKept) {
          const remainingToEvaluate = hardEvaluationCap - cursor;
          const batchSize = Math.min(ibkrScanBatchSize, remainingToEvaluate);
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
        const testedCount = Array.isArray(payload?.testedSymbols)
          ? payload.testedSymbols.length
          : testedSymbols.length;
        const retainedCount = Number.isFinite(Number(payload?.kept))
          ? Number(payload.kept)
          : Array.isArray(payload?.shortlist)
          ? payload.shortlist.length
          : 0;
        setLastScanPoolMeta((prev) => ({
          ...prev,
          ibkrTested: testedCount,
          ibkrRetained: retainedCount,
          ibkrAuditDepth: finalTarget,
        }));
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
            archiveScanFunnel({
              scanSessionId: scanId,
              scanTimestamp,
              captureSource: "ibkr_auto_final",
              sourceOverrides: {
                ibkrDirectResult: payload,
                ibkrDirectSentTickers: testedSymbols,
                displayedSymbols: applied.map((c) =>
                  String(c?.ticker || c?.symbol || "").trim().toUpperCase()
                ).filter(Boolean),
              },
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
        setIbkrMemoryRefreshKey((v) => v + 1);
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
    // Garde-fou marché fermé : ne pas lancer le scan avec une expiration sur un jour fermé
    // (week-end / férié US) si aucune date d'expiration ouverte ne peut être déterminée.
    const expirationAdjustment = getAdjustedExpirationForClosedMarket(selectedExpirationRef.current);
    if (
      expirationAdjustment.closed &&
      (expirationAdjustment.blocked || !expirationAdjustment.adjusted)
    ) {
      const blockMsg = `Scan bloqué : ${expirationAdjustment.original ?? selectedExpirationRef.current} est un jour de marché US fermé sans expiration ajustée disponible (utiliser le jeudi précédent).`;
      console.warn("[SCAN_BLOCKED_CLOSED_MARKET]", {
        selected: selectedExpirationRef.current,
        reason: expirationAdjustment.reason,
      });
      setScanError(blockMsg);
      setRefreshStage(blockMsg);
      return;
    }
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

    let tickers = [];
    let poolSource = "strict_watchlist";
    let usedFallbackUltimate = false;

    const resolved = resolvePreIbkrTickers({
      watchlistTickers,
      preIbkrPoolMode,
      researchExpandedPool,
      researchExpandedLimit,
      fallbackTickers: FALLBACK_TICKERS,
    });
    tickers = resolved.tickers;
    poolSource = resolved.poolSource;
    usedFallbackUltimate = resolved.usedFallbackUltimate;

    if (poolSource === "research_expanded" && resolved.researchExpandedDiagnostics) {
      console.log("[RESEARCH_EXPANDED_POOL]", {
        requestedMode: resolved.requestedMode,
        ...resolved.researchExpandedDiagnostics,
      });
    }

    if (Array.isArray(watchlistTickers) && watchlistTickers.length === 0) {
      setWatchlistBuildError(
        buildStrictWatchlistEmptyInfo({
          poolSource,
          tickersCount: tickers.length,
          usedFallbackUltimate,
        })
      );
    } else if (watchlistTickers?.length > 0) {
      setWatchlistBuildError("");
    }

    setLastScanPoolMeta((prev) => ({
      ...prev,
      poolSource,
      preIbkrCount: tickers.length,
      ibkrAuditDepth: Math.min(120, Math.max(10, Number(ibkrAutoMaxTickers) || 20)),
      usedFallbackUltimate,
      ibkrAutoLaunched: false,
      ibkrAutoSkipReason: "",
    }));

    if (!Array.isArray(tickers) || tickers.length === 0) {
      console.log("[SCAN_DEBUG] scan_cancelled_reason", "no_tickers_to_scan");
      const noTickerMsg = "Aucun ticker disponible pour lancer le scan.";
      setScanError(noTickerMsg);
      setBackendCandidates(null);
      setDataSource("snapshot");
      setPrimaryIbkrSourceInfo(null);
      setScanMeta({ scanned: 0, kept: 0, returned: 0 });
      setYahooSentToScanCount(0);
      setYahooScanErrorCount(0);
      setYahooRequestedTopN(0);
      setYahooChallengerCount(0);
      setLastScanPoolMeta((prev) => ({
        ...prev,
        poolSource,
        preIbkrCount: 0,
        yahooSent: 0,
        yahooReturned: 0,
        ibkrAutoLaunched: false,
        ibkrAutoSkipReason: shouldRunAutoIbkr
          ? buildIbkrAutoNetworkSkipMessage({ poolSource, preIbkrCount: 0, hasCache: false })
          : "",
      }));
      if (shouldRunAutoIbkr) {
        const skipMsg = buildIbkrAutoNetworkSkipMessage({ poolSource, preIbkrCount: 0, hasCache: false });
        setRefreshStage(skipMsg);
      }
      return;
    }
    console.log("[SCAN_DEBUG] tickers_sent_to_scan", tickers.length, "poolSource", poolSource);
    setYahooSentToScanCount(tickers.length);
    setYahooScanErrorCount(0);
    setYahooRequestedTopN(Number(topN) || 0);
    setYahooChallengerCount(0);

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
      const mappedTagged = applyResearchExpandedFlagsToCandidates(mappedRaw, poolSource);
      const mapped = tagCandidatesOffMarketNonTradable(mappedTagged, marketClosed);
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
      setYahooScanErrorCount(Array.isArray(payload?.errors) ? payload.errors.length : 0);
      setYahooRequestedTopN(Number(payload?.requestedTopN ?? topN) || 0);
      setYahooChallengerCount(Number(payload?.challengerCount ?? 0) || 0);
      setYahooReturnedCandidates(mapped);
      if (payload?.scanTiming && typeof payload.scanTiming === "object") {
        setYahooScanTiming(payload.scanTiming);
      }
      const nextYahooDiagnostics = buildYahooDiagnosticsFromScanPayload(payload, {
        scanned: payload.scanned ?? tickers.length,
        kept: payload.kept ?? mapped.length,
        returned: payload.returned ?? mapped.length,
      });
      const nextYahooRejectedBySymbol = buildYahooRejectedBySymbol(payload?.rejected);
      setYahooDiagnostics(nextYahooDiagnostics);
      setYahooRejectedBySymbol(nextYahooRejectedBySymbol);

      setLastScanPoolMeta((prev) => ({
        ...prev,
        poolSource,
        preIbkrCount: tickers.length,
        yahooSent: payload.scanned ?? tickers.length,
        yahooReturned: payload.returned ?? mapped.length,
        ibkrAuditDepth: Math.min(120, Math.max(10, Number(ibkrAutoMaxTickers) || 20)),
      }));

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
            poolSource,
          });
          setLastScanPoolMeta((prev) => ({
            ...prev,
            ibkrAutoLaunched: true,
            ibkrAutoSkipReason: "",
          }));
        } else {
          const skipMsg = buildIbkrAutoSkipMessage({
            poolSource,
            preIbkrCount: tickers.length,
            fromCache: false,
          });
          setScanError(skipMsg);
          setRefreshStage(skipMsg);
          setLastScanPoolMeta((prev) => ({
            ...prev,
            poolSource,
            preIbkrCount: tickers.length,
            yahooSent: payload.scanned ?? tickers.length,
            yahooReturned: 0,
            ibkrAutoLaunched: false,
            ibkrAutoSkipReason: skipMsg,
          }));
          console.warn("[IBKR_AUTO_SKIPPED]", {
            scanId,
            poolSource,
            preIbkrCount: tickers.length,
            reason: "mapped.length === 0 après scan_shortlist",
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
        archiveScanFunnel({ scanSessionId: scanId, scanTimestamp, captureSource: "yahoo_final" });
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
        setYahooSentToScanCount(Number(cached?.scanMeta?.scanned ?? tagged.length) || tagged.length);
        setYahooScanErrorCount(0);
        setYahooRequestedTopN(Number(topN) || 0);
        setYahooChallengerCount(0);
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
        setYahooSentToScanCount(tickers.length);
        setYahooScanErrorCount(1);
        setYahooRequestedTopN(Number(topN) || 0);
        setYahooChallengerCount(0);
        setYahooReturnedCandidates([]);
        setYahooDiagnostics(
          normalizeYahooDiagnosticsForState(null, {
            scanned: tickers.length,
            kept: 0,
            returned: 0,
          })
        );
        setYahooRejectedBySymbol({});
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
            setLastScanPoolMeta((prev) => ({
              ...prev,
              ibkrAutoLaunched: true,
              ibkrAutoSkipReason: "",
            }));
          } else {
            const skipMsg = buildIbkrAutoSkipMessage({
              poolSource,
              preIbkrCount: tickers.length,
              fromCache: true,
            });
            setScanError(skipMsg);
            setRefreshStage(skipMsg);
            setLastScanPoolMeta((prev) => ({
              ...prev,
              ibkrAutoLaunched: false,
              ibkrAutoSkipReason: skipMsg,
            }));
            console.warn("[IBKR_AUTO_SKIPPED]", {
              scanId,
              poolSource,
              preIbkrCount: tickers.length,
              reason: "cache taggedForIbkr vide — pas de fallback watchlist",
            });
            setTimeout(() => {
              setTimeout(() => logScanDisplayResult(scanId, displaySnapshotRef), 0);
            }, 0);
          }
        } else {
          const skipMsg = buildIbkrAutoNetworkSkipMessage({
            poolSource,
            preIbkrCount: tickers.length,
            hasCache: false,
          });
          setIbkrDirectError("");
          setRefreshStage(skipMsg);
          setLastScanPoolMeta((prev) => ({
            ...prev,
            poolSource,
            preIbkrCount: tickers.length,
            yahooSent: tickers.length,
            yahooReturned: 0,
            ibkrAutoLaunched: false,
            ibkrAutoSkipReason: skipMsg,
          }));
          console.warn("[IBKR_AUTO_SKIPPED]", {
            scanId,
            poolSource,
            preIbkrCount: tickers.length,
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
  }, [watchlistTickers, preIbkrPoolMode, researchExpandedPool, researchExpandedLimit, selectedExpiration, topN, autoIbkrDirectScan, ibkrAutoMaxTickers, rememberTechnicalCandidates, displaySnapshotRef, captureWheelJournalSnapshot]);

  useEffect(() => {
    rememberTechnicalCandidates(activeCandidates);
  }, [activeCandidates, rememberTechnicalCandidates]);

  useEffect(() => {
    rememberTechnicalCandidates(mergedIbkrYahooCandidates);
  }, [mergedIbkrYahooCandidates, rememberTechnicalCandidates]);

  const handleReloadResearchExpandedPool = useCallback(async () => {
    setResearchExpandedPoolSource("loading");
    setResearchExpandedPoolError("");
    try {
      const result = await loadResearchExpandedPoolWithFallback({
        limit: researchExpandedLimit,
        maxPrice: researchExpandedMaxPrice,
        includeAboveMaxPrice: researchExpandedIncludeAboveMaxPrice,
        flagUnreliable: researchExpandedFlagUnreliable,
      });
      setResearchExpandedPool(Array.isArray(result.pool) ? result.pool : []);
      setResearchExpandedStats(result.stats ?? null);
      setResearchExpandedPoolSource(result.source ?? "backend");
      if (result.usedStaticFallback) {
        setResearchExpandedPoolError(result.error || "Pool research : secours statique utilisé.");
      }
    } catch (err) {
      setResearchExpandedPool([]);
      setResearchExpandedStats(null);
      setResearchExpandedPoolSource("error");
      setResearchExpandedPoolError(String(err?.message || err || "Pool research indisponible"));
    }
  }, [
    researchExpandedLimit,
    researchExpandedMaxPrice,
    researchExpandedIncludeAboveMaxPrice,
    researchExpandedFlagUnreliable,
  ]);

  const handleRebuildWatchlist = useCallback(async () => {
    setWatchlistLoading(true);
    setWatchlistBuildError("");
    try {
      const body = { ...DEFAULT_BUILD_WATCHLIST_BODY, liquidityOtmProbePct: watchlistOtmProbePct };
      const payload = await callBuildWatchlist(body);
      setWatchlistTickers(Array.isArray(payload.watchlist) ? payload.watchlist : []);
      setWatchlistSource("backend");
      setWatchlistStats(payload.stats ?? null);
      const wlDiag = extractWatchlistBuildDiagnostics(payload);
      setWatchlistRejectedRows(wlDiag.watchlistRejectedRows);
      setWatchlistTruncatedSymbols(wlDiag.watchlistTruncatedSymbols);
      setWatchlistRejectedBySymbol(wlDiag.watchlistRejectedBySymbol);
    } catch (err) {
      setWatchlistTickers(FALLBACK_TICKERS);
      setWatchlistSource("fallback");
      setWatchlistStats(null);
      setWatchlistRejectedRows([]);
      setWatchlistTruncatedSymbols([]);
      setWatchlistRejectedBySymbol({});
      setWatchlistBuildError(String(err?.message || err || "universe/build indisponible"));
    } finally {
      setWatchlistLoading(false);
    }
  }, [watchlistOtmProbePct]);

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
          archiveScanFunnel({
            scanSessionId,
            scanTimestamp,
            captureSource: "ibkr_manual_final",
            sourceOverrides: {
              ibkrDirectResult: payload,
              ibkrDirectSentTickers: tickersToSend,
              displayedSymbols: applied.map((c) =>
                String(c?.ticker || c?.symbol || "").trim().toUpperCase()
              ).filter(Boolean),
            },
          });
          setIbkrDirectError("");
        }
      }
    } catch (err) {
      setIbkrDirectError(String(err?.message || err || "IBKR Direct Scan indisponible"));
    } finally {
      setIbkrDirectLoading(false);
      setIbkrMemoryRefreshKey((v) => v + 1);
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
      setIbkrMemoryRefreshKey((v) => v + 1);
    }
  }, [selectedExpiration, ibkrDirectClientIdStart, applyIbkrDirectShortlistToPrimary]);

  // Page "Analyse titre" : recherche le symbole dans les données déjà chargées.
  // Aucun appel API — uniquement les collections déjà en mémoire. Priorité :
  // 1) carte finale affichée, 2) résultat IBKR direct, 3) Yahoo/backend, 4) rejet/diagnostic.
  const findTickerInCurrentScan = useCallback(
    (rawSymbol) => {
      const symbol = String(rawSymbol || "").trim().toUpperCase();
      if (!symbol) return null;
      const up = (v) => String(v ?? "").trim().toUpperCase();

      const finalHit = enrichedCandidates.find(
        (it) => up(it?.ticker ?? it?.symbol) === symbol
      );
      if (finalHit) return { data: finalHit, source: "cartes finales" };

      const ibkrHit = ibkrDirectByTicker.get(symbol);
      if (ibkrHit) return { data: ibkrHit, source: "IBKR" };

      const yahooHit = yahooCandidateByTicker.get(symbol);
      if (yahooHit) return { data: yahooHit, source: "Yahoo" };

      const rejected = Array.isArray(ibkrDirectResult?.rejected)
        ? ibkrDirectResult.rejected
        : [];
      const rejectHit = rejected.find((r) => up(r?.symbol) === symbol);
      if (rejectHit) return { data: rejectHit, source: "diagnostic" };

      return null;
    },
    [enrichedCandidates, ibkrDirectByTicker, yahooCandidateByTicker, ibkrDirectResult]
  );

  // Scan individuel MANUEL (au clic seulement). Réutilise l'endpoint shadow existant
  // /ibkr/shadow/scan (lecture seule, aucun ordre) via callIbkrDirectScan, mais stocke
  // le résultat dans un état LOCAL à la page Ticker : ne touche ni ibkrDirectResult ni la
  // shortlist principale (Opportunités reste intacte).
  const handleScanSingleTicker = useCallback(async () => {
    const symbol = String(tickerInput || "").trim().toUpperCase();
    if (!symbol) return;
    setTickerActive(symbol);
    setTickerScanLoading(true);
    setTickerScanError("");
    setTickerScanResult(null);
    try {
      const expLocked = selectedExpirationRef.current;
      const payload = await callIbkrDirectScan({
        tickers: [symbol],
        expiration: ymdToIbkr(expLocked),
        clientIdStart: ibkrDirectClientIdStart,
        maxTickers: 1,
        topN: 1,
        auditDepth: 1,
      });
      setTickerScanResult({ symbol, expiration: expLocked, payload });
    } catch (err) {
      setTickerScanError(String(err?.message || err || "Scan individuel indisponible"));
    } finally {
      setTickerScanLoading(false);
    }
  }, [tickerInput, ibkrDirectClientIdStart]);

  // "Rechercher" : ne fait QUE chercher en mémoire (aucun appel API). Réinitialise le
  // résultat de scan individuel précédent pour éviter d'afficher une fiche périmée.
  const handleSearchTicker = useCallback(() => {
    setTickerActive(String(tickerInput || "").trim().toUpperCase());
    setTickerScanResult(null);
    setTickerScanError("");
  }, [tickerInput]);

  // Diagnostic pipeline de la page Ticker — reconstruit le chemin pipeline du
  // symbole recherché (tickerActive) à partir de l'état déjà chargé. Lecture
  // seule, aucun fetch, isolé d'Opportunités et du scan individuel manuel.
  const tickerPipelineView = useMemo(() => {
    const sym = String(tickerActive || "").trim().toUpperCase();
    if (!sym) return null;
    const up = (v) => String(v ?? "").trim().toUpperCase();

    const scanLoaded =
      (Array.isArray(tickersForScan) && tickersForScan.length > 0) ||
      (Array.isArray(yahooReturnedCandidates) && yahooReturnedCandidates.length > 0) ||
      (Array.isArray(enrichedCandidates) && enrichedCandidates.length > 0) ||
      ibkrDirectResult != null;

    if (!scanLoaded) return { available: false, symbol: sym, scanLoaded: false };

    let diagnostic = null;
    try {
      diagnostic = buildTickerPipelineDiagnostic(sym, {
        tickersForScan,
        yahooReturnedCandidates,
        yahooDiagnostics,
        yahooRejectedBySymbol,
        watchlistRejectedBySymbol,
        watchlistTickers: watchlistTickers ?? [],
        watchlistTruncatedSymbols,
        researchExpandedPool,
        preIbkrPoolMode,
        cryptoBlockedRemovedSymbols,
        ibkrDirectSentTickers,
        ibkrDirectResult,
        backendCandidates: backendCandidates ?? [],
        enrichedCandidates,
        filtered,
        combos,
        capital: Number(capital),
        maxCapitalPct: Number(maxCapitalPct),
        ibkrRejectedSymbols,
        yahooRankForIbkrBySymbol,
        selectedExpiration,
        filter,
        dataSource,
        topN,
        ibkrAutoMaxTickers,
        liquidityOtmProbePctSelected: watchlistOtmProbePct,
        liquidityOtmProbePctApplied: watchlistStats?.liquidityOtmProbePctApplied ?? null,
        scanPoolSource: lastScanPoolMeta.poolSource || preIbkrPoolMode,
        watchlistMode: watchlistStats?.watchlistMode ?? DEFAULT_BUILD_WATCHLIST_BODY.watchlistMode,
      });
    } catch {
      diagnostic = null;
    }
    if (!diagnostic) return { available: false, symbol: sym, scanLoaded };

    const inPreScanPool = (tickersForScan || []).some((t) => up(t) === sym);
    const inScan =
      inPreScanPool ||
      diagnostic.presentInYahoo ||
      diagnostic.presentInIbkrShortlist ||
      diagnostic.presentInIbkrRejected ||
      diagnostic.presentInEnriched ||
      diagnostic.presentInBackendCandidates ||
      diagnostic.presentInFilteredCards;

    // Raison de la fiche décisionnelle (priorité 4 de la raison principale).
    const match = findTickerInCurrentScan(sym);
    const decisionReason = match ? buildTickerDecision(match.data)?.reason ?? null : null;

    const built = buildTickerPipelineStages(diagnostic, {
      symbol: sym,
      scanLoaded,
      inPreScanPool,
      inScan,
      decisionReason,
    });
    return { available: true, symbol: sym, scanLoaded, diagnostic, ...built };
  }, [
    tickerActive,
    tickersForScan,
    yahooReturnedCandidates,
    yahooDiagnostics,
    yahooRejectedBySymbol,
    watchlistRejectedBySymbol,
    watchlistTickers,
    watchlistTruncatedSymbols,
    researchExpandedPool,
    preIbkrPoolMode,
    cryptoBlockedRemovedSymbols,
    ibkrDirectSentTickers,
    ibkrDirectResult,
    backendCandidates,
    enrichedCandidates,
    filtered,
    combos,
    capital,
    maxCapitalPct,
    ibkrRejectedSymbols,
    yahooRankForIbkrBySymbol,
    selectedExpiration,
    filter,
    dataSource,
    topN,
    ibkrAutoMaxTickers,
    watchlistOtmProbePct,
    watchlistStats,
    lastScanPoolMeta.poolSource,
    findTickerInCurrentScan,
  ]);

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
        const body = { ...DEFAULT_BUILD_WATCHLIST_BODY, liquidityOtmProbePct: watchlistOtmProbePct };
        const payload = await callBuildWatchlist(body);
        if (cancelled) return;
        setWatchlistTickers(Array.isArray(payload.watchlist) ? payload.watchlist : []);
        setWatchlistSource("backend");
        setWatchlistStats(payload.stats ?? null);
        const wlDiag = extractWatchlistBuildDiagnostics(payload);
        setWatchlistRejectedRows(wlDiag.watchlistRejectedRows);
        setWatchlistTruncatedSymbols(wlDiag.watchlistTruncatedSymbols);
        setWatchlistRejectedBySymbol(wlDiag.watchlistRejectedBySymbol);
      } catch (err) {
        if (cancelled) return;
        setWatchlistTickers(FALLBACK_TICKERS);
        setWatchlistSource("fallback");
        setWatchlistStats(null);
        setWatchlistRejectedRows([]);
        setWatchlistTruncatedSymbols([]);
        setWatchlistRejectedBySymbol({});
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
    void handleReloadResearchExpandedPool();
  }, [handleReloadResearchExpandedPool]);

  useEffect(() => {
    try {
      window.localStorage.setItem("wheel.preIbkrPoolMode", preIbkrPoolMode);
      window.localStorage.setItem(
        "wheel.researchExpandedEnabled",
        preIbkrPoolMode === "research_expanded" ? "true" : "false"
      );
    } catch {
      /* quota / private mode */
    }
    setResearchExpandedEnabled(preIbkrPoolMode === "research_expanded");
  }, [preIbkrPoolMode]);

  useEffect(() => {
    try {
      window.localStorage.setItem("wheel.researchExpandedLimit", String(researchExpandedLimit));
    } catch {
      /* quota / private mode */
    }
  }, [researchExpandedLimit]);

  useEffect(() => {
    try {
      if (researchExpandedMaxPrice == null) {
        window.localStorage.removeItem("wheel.researchExpandedMaxPrice");
      } else {
        window.localStorage.setItem("wheel.researchExpandedMaxPrice", String(researchExpandedMaxPrice));
      }
      window.localStorage.setItem(
        "wheel.researchExpandedIncludeAboveMaxPrice",
        researchExpandedIncludeAboveMaxPrice ? "true" : "false"
      );
      window.localStorage.setItem(
        "wheel.researchExpandedFlagUnreliable",
        researchExpandedFlagUnreliable ? "true" : "false"
      );
    } catch {
      /* quota / private mode */
    }
  }, [researchExpandedMaxPrice, researchExpandedIncludeAboveMaxPrice, researchExpandedFlagUnreliable]);

  useEffect(() => {
    try {
      window.localStorage.setItem("wheel.liquidityOtmProbePct", String(watchlistOtmProbePct));
    } catch {
      /* quota / private mode */
    }
  }, [watchlistOtmProbePct]);

  useEffect(() => {
    handleRefreshScanMetrics();
  }, [handleRefreshScanMetrics]);

  useEffect(() => {
    if (isPastYmd(selectedExpiration)) {
      const nextExpiration = pickDefaultExpiration(DEFAULT_EXPIRATION_VALUES);
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

  // Navigation sidebar : change de vue si besoin puis scroll vers l'ancre.
  // Aucune logique métier — uniquement setActiveView (handlers existants) + scrollIntoView.
  const handleSidebarNavigate = useCallback(
    (item) => {
      const targetView = item.view || "dashboard";
      const needsSwitch = activeView !== targetView;
      if (needsSwitch) setActiveView(targetView);
      if (item.anchor) {
        const doScroll = () => {
          const el = document.getElementById(item.anchor);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
        };
        // Laisse React rendre la vue dashboard avant de scroller.
        if (needsSwitch) window.setTimeout(doScroll, 90);
        else doScroll();
      } else if (needsSwitch) {
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    },
    [activeView]
  );

  // LAB 5174 : neutralise la bannière rouge plein écran injectée par main.jsx
  // (hors périmètre dashboard.jsx). L'info LAB est conservée via le badge discret
  // « LAB 5174 » du top nav, à côté du statut OK.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const root = document.getElementById("root");
    if (!root) return undefined;
    for (const child of Array.from(root.children)) {
      const text = (child.textContent || "").trim();
      if (text.startsWith("🧪 LAB UI") || text.includes("LAB UI — port 5174")) {
        child.style.display = "none";
        break;
      }
    }
    return undefined;
  }, []);

  const isOpportunitiesView = activeView === "dashboard";
  return (
    <div className="min-h-screen bg-[#0b1117] text-slate-100">
      {isOpportunitiesView && (
        <WheelTopNav activeView={activeView} onNavigate={handleSidebarNavigate} />
      )}
      <div className="flex min-h-screen">
        {!isOpportunitiesView && (
          <WheelSidebar activeView={activeView} onNavigate={handleSidebarNavigate} />
        )}
        <main className="min-w-0 flex-1">
      <div className={activeView === "seasonality" ? "w-full" : "w-full px-2 py-3 md:px-3 lg:px-4"}>
        {activeView !== "seasonality" && activeView !== "diagnostics" && activeView !== "ticker" && activeView !== "dashboard" && <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 rounded-[28px] border border-slate-700 bg-slate-900 p-6 shadow-sm"
        >
          <div className="flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-800/50 px-3 py-1 text-xs font-medium text-slate-400">
                <Layers3 className="h-3.5 w-3.5" />
                Wheel Strategy Dashboard — backend shortlist + modal live
              </div>
              <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-50 md:text-4xl">
                Dashboard options lisible, premium et actionnable
              </h1>
              <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400 md:text-base">
                La watchlist est construite via /universe/build ; le bouton Refresh shortlist interroge /scan_shortlist avec cette liste. Le modal reste live pour lecture détaillée.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:w-[640px]">
              {stats.map((item) => (
                <StatCard key={item.title} item={item} />
              ))}
            </div>
          </div>
        </motion.div>}


        {activeView === "seasonality" ? (
          <React.Suspense
            fallback={
              <div className="rounded-[28px] border border-slate-700 bg-slate-900 p-8 text-sm text-slate-500 shadow-sm">
                Chargement de la saisonnalité…
              </div>
            }
          >
            <SeasonalityPanel apiBase={API_BASE} onNavigate={setActiveView} />
          </React.Suspense>

        ) : activeView === "diagnostics" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5 shadow-xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-300">
                Diagnostics
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-white">
                Diagnostics du scan
              </h1>
              <p className="mt-2 text-sm text-slate-300">
                Vue de contrôle complète du pipeline Yahoo → IBKR → affichage final.
              </p>
              <p className="mt-1 text-xs text-sky-300/70">
                Diagnostics en lecture seule — aucun ordre envoyé.
              </p>
              <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/70 p-4 text-sm text-slate-300">
                Utilise cette page pour identifier où les candidats sont coupés : Yahoo, pré-IBKR, IBKR ou affichage final.
              </div>
            </div>
        <DiagnosticsSection
          title="Vue rapide"
          description="Synthèse des volumes, conversions et goulots du dernier scan."
        >
        {refreshStage && (
          <div className="mb-6 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm font-medium text-slate-300 shadow-sm">
            {refreshStage}
          </div>
        )}
        {(yahooScanMeta.scanned > 0 || ibkrSentCount > 0 || ibkrDirectResult || lastScanPoolMeta.preIbkrCount > 0) && (
          <div className="mb-6 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300 shadow-sm">
            <details open>
              <summary className="cursor-pointer font-semibold text-slate-100">Résumé du funnel</summary>
              <div className="mt-3 rounded-xl border border-indigo-900 bg-indigo-950/40 p-3 text-xs text-slate-300">
                <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                  <div>
                    <span className="text-slate-500">Mode choisi</span>
                    <div className="font-semibold text-slate-100">
                      {formatPoolSourceLabel(preIbkrPoolMode)}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Pool effectif (dernier scan)</span>
                    <div className="font-semibold text-slate-100">
                      {formatPoolSourceLabel(lastScanPoolMeta.poolSource || resolvedPreIbkrPool.poolSource)}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Pool pré-Yahoo</span>
                    <div className="font-semibold text-slate-100">
                      {lastScanPoolMeta.preIbkrCount || _rawWatchlist.length || 0}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Yahoo sent/scanned</span>
                    <div className="font-semibold text-slate-100">
                      {lastScanPoolMeta.yahooSent || yahooScanMeta.scanned || yahooSentToScanCount || 0}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Yahoo retournés</span>
                    <div className="font-semibold text-slate-100">
                      {lastScanPoolMeta.yahooReturned || yahooReturnedCount || 0}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">IBKR Audit Depth</span>
                    <div className="font-semibold text-slate-100">
                      {lastScanPoolMeta.ibkrAuditDepth || ibkrFinalTarget}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">IBKR testés</span>
                    <div className="font-semibold text-slate-100">
                      {lastScanPoolMeta.ibkrTested || ibkrTestedCount}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">IBKR retenus</span>
                    <div className="font-semibold text-slate-100">
                      {lastScanPoolMeta.ibkrRetained || ibkrKeptCount}
                    </div>
                  </div>
                  <div>
                    <span className="text-slate-500">Journal POP capturés</span>
                    <div className="font-semibold text-slate-100">{lastJournalPopCaptured}</div>
                  </div>
                  <div>
                    <span className="text-slate-500">IBKR auto lancé</span>
                    <div className="font-semibold text-slate-100">
                      {lastScanPoolMeta.ibkrAutoLaunched || ibkrSentCount > 0 ? "oui" : "non"}
                    </div>
                  </div>
                </div>
                {lastScanPoolMeta.ibkrAutoSkipReason ? (
                  <p className="mt-2 text-amber-300">{lastScanPoolMeta.ibkrAutoSkipReason}</p>
                ) : null}
                {lastScanPoolMeta.usedFallbackUltimate ? (
                  <p className="mt-2 text-amber-300">
                    Pool Research Expanded indisponible — secours fallback 65 utilisé pour ce scan.
                  </p>
                ) : null}
                {(lastScanPoolMeta.ibkrTested || ibkrTestedCount) <
                Math.min(
                  lastScanPoolMeta.ibkrAuditDepth || ibkrFinalTarget,
                  lastScanPoolMeta.yahooReturned || yahooReturnedCount || 0
                ) ? (
                  <p className="mt-2 text-slate-400">
                    IBKR testés &lt; Audit Depth : Yahoo a renvoyé{" "}
                    {lastScanPoolMeta.yahooReturned || yahooReturnedCount || 0} candidats (plafond réel = min(Yahoo
                    retournés, Audit Depth)).
                  </p>
                ) : null}
              </div>
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
            {ibkrDirectResult?.ok === true && (
              <div className="mt-4 rounded-xl border border-sky-900 bg-slate-800/80 px-3 py-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                  Traçabilité Yahoo → IBKR (observabilité)
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                  <Metric label="Yahoo Returned" value={String(ibkrTraceYahooReturnedForFunnel)} />
                  <Metric label="IBKR Sent / Tested" value={String(ibkrTestedCount)} />
                  <Metric label="IBKR Retained" value={String(ibkrTotalKeptCollected)} tone="good" />
                  <Metric label="IBKR Rejected" value={String(ibkrRejectedCount)} tone={ibkrRejectedCount ? "warn" : "default"} />
                  <Metric label="IBKR Non Tested" value={String(ibkrNonTestedCount)} />
                  <Metric label="Fusion IBKR (batches)" value={String(ibkrDirectResult.progressiveIbkrBatchCount ?? "—")} />
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-400">
                  <span className="font-semibold text-slate-200">Top IBKR rejection reasons:</span>{" "}
                  {ibkrTraceTopReasonLines.length
                    ? ibkrTraceTopReasonLines.join(" · ")
                    : "(aucune raison agrégée — voir tableau rejetés par symbole)"}
                </p>
              </div>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Lecture visuelle seulement : actionnable = finalDisplayMode SAFE/AGGRESSIVE avec finalDisplayGrade A/B.
            </p>
            {ibkrDirectResult?.progressiveAutoIbkr && ibkrTotalKeptCollected < ibkrFinalTarget && (
              <p className="mt-2 rounded-xl border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm font-semibold text-amber-300">
                Seulement {ibkrTotalKeptCollected} retenus IBKR disponibles dans le bassin Yahoo testé.
              </p>
            )}
            </details>
          </div>
        )}

        {(Number(yahooScanMeta.scanned) > 0 || yahooRejectedCount > 0) && (
          <div className="mb-6 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300 shadow-sm">
            <details open>
              <summary className="cursor-pointer font-semibold text-slate-100">
                PIPELINE FUNNEL DIAGNOSTICS
              </summary>
              <p className="mt-2 text-xs text-slate-400">
                Universe: {pipelineFunnelDiagnostics.universeMasterActive} · Watchlist: {pipelineFunnelDiagnostics.watchlistKept} · Yahoo Sent: {pipelineFunnelDiagnostics.tickersSentToScan} · Yahoo Qualified: {pipelineFunnelDiagnostics.passesFilterTrue} · Yahoo Unreliable: {pipelineFunnelDiagnostics.keptUnreliable} · Yahoo Returned: {pipelineFunnelDiagnostics.returned} · UI Visible: {pipelineFunnelDiagnostics.visibleAfterTopN} · Filtered Final: {pipelineFunnelDiagnostics.filteredFinalCount} · Combo Pool: {pipelineFunnelDiagnostics.comboBasePoolCount}
              </p>
              {dataSource === "ibkr_direct" && primaryIbkrSourceInfo && (
                <p className="mt-1 text-xs text-amber-300">
                  IBKR auto : affichage prima limité à {ibkrFinalTarget} lignes — shortlist Yahoo en mémoire{" "}
                  {yahooReturnedCount}, fusion IBKR avant cap{" "}
                  {Number(primaryIbkrSourceInfo.totalKeptCollected) || "—"}, hors écran{" "}
                  {Number(primaryIbkrSourceInfo.retainedNotDisplayed) || 0}. L’écart « Yahoo Returned vs UI Visible » vient
                  surtout de ce plafond / des rejets IBKR, pas du SAFE Wheel.
                </p>
              )}

              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Master actifs (univers)" value={String(pipelineFunnelDiagnostics.universeMasterActive)} />
                <Metric label="Catégories sélectionnées" value={String(pipelineFunnelDiagnostics.categoriesSelected)} />
                <Metric label="Exclus crypto (univers)" value={String(pipelineFunnelDiagnostics.excludedCrypto)} tone={pipelineFunnelDiagnostics.excludedCrypto > 0 ? "warn" : "default"} />
                <Metric label="Exclus filtres build" value={String(pipelineFunnelDiagnostics.buildExcluded)} tone={pipelineFunnelDiagnostics.buildExcluded > 0 ? "warn" : "default"} />
              </div>
              {(pipelineFunnelDiagnostics.excludedCrypto > 0 ||
                (pipelineFunnelDiagnostics.cryptoBlockedRemovedSymbols?.length ?? 0) > 0) && (
                <div className="mt-2 rounded-lg border border-amber-900/40 bg-amber-950/20 p-2 text-[11px] text-amber-100/90">
                  <p>
                    <span className="font-medium text-amber-200">Crypto supprimées :</span>{" "}
                    {pipelineFunnelDiagnostics.excludedCrypto}
                    {pipelineFunnelDiagnostics.cryptoBlockedRemovedSymbols?.length
                      ? ` — ${pipelineFunnelDiagnostics.cryptoBlockedRemovedSymbols.join(", ")}`
                      : ""}
                  </p>
                  {pipelineFunnelDiagnostics.cryptoAllowedRetained?.length > 0 && (
                    <p className="mt-1 text-emerald-300/90">
                      Exception conservée : {pipelineFunnelDiagnostics.cryptoAllowedRetained.join(", ")} (BITX autorisé)
                    </p>
                  )}
                  <p className="mt-1 text-amber-200/70">Raison : {CRYPTO_BLOCK_REASON}</p>
                </div>
              )}
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Watchlist kept/rejected" value={`${pipelineFunnelDiagnostics.watchlistKept} / ${pipelineFunnelDiagnostics.watchlistRejected}`} />
                <Metric label="Watchlist limit applied" value={String(pipelineFunnelDiagnostics.watchlistLimitApplied)} />
                <Metric
                  label="Sonde OTM % (dernier build)"
                  value={
                    watchlistStats?.liquidityOtmProbePctApplied == null
                      ? "—"
                      : `${watchlistStats.liquidityOtmProbePctApplied}%${
                          watchlistStats.liquidityOtmProbeActive ? "" : " (off)"
                        }`
                  }
                />
                <Metric label="Yahoo sent/scanned" value={`${pipelineFunnelDiagnostics.tickersSentToScan} / ${pipelineFunnelDiagnostics.scanned}`} />
                <Metric label="Scan failures" value={String(pipelineFunnelDiagnostics.scanFailures)} tone={pipelineFunnelDiagnostics.scanFailures > 0 ? "warn" : "default"} />
                <Metric label="Expiration unavailable" value={String(pipelineFunnelDiagnostics.expirationUnavailable)} tone={pipelineFunnelDiagnostics.expirationUnavailable > 0 ? "warn" : "default"} />
                <Metric label="Duplicate removed" value={String(pipelineFunnelDiagnostics.duplicateRemoved)} />
                <Metric label="passesFilter TRUE" value={String(pipelineFunnelDiagnostics.passesFilterTrue)} tone="good" />
                <Metric label="keptUnreliable" value={String(pipelineFunnelDiagnostics.keptUnreliable)} tone={pipelineFunnelDiagnostics.keptUnreliable > 0 ? "warn" : "default"} />
                <Metric label="requestedTopN/challenger" value={`${pipelineFunnelDiagnostics.requestedTopN} / ${pipelineFunnelDiagnostics.challengerCount}`} />
                <Metric label="returned/hiddenReturned" value={`${pipelineFunnelDiagnostics.returned} / ${pipelineFunnelDiagnostics.hiddenReturnedCandidates}`} />
                <Metric label="UI removed S/V/E" value={`${pipelineFunnelDiagnostics.removedBySearch} / ${pipelineFunnelDiagnostics.removedByVerdict} / ${pipelineFunnelDiagnostics.removedByExpiration}`} />
                <Metric label="Combo usable S/B/A" value={`${pipelineFunnelDiagnostics.usableForSAFE} / ${pipelineFunnelDiagnostics.usableForBALANCED} / ${pipelineFunnelDiagnostics.usableForAGGRESSIVE}`} />
              </div>

              <div className="mt-3 rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                <p className="font-medium text-slate-100">Conversion rates</p>
                <div className="mt-2 space-y-2 text-xs text-slate-300">
                  <div>
                    Fill rate watchlist: {pipelineFunnelDiagnostics.fillRatePct.toFixed(1)}%
                    <div className="mt-1 h-2 w-full rounded bg-slate-700">
                      <div className="h-2 rounded bg-sky-500" style={{ width: `${clampPct(pipelineFunnelDiagnostics.fillRatePct)}%` }} />
                    </div>
                  </div>
                  <div>
                    Qualification rate: {pipelineFunnelDiagnostics.qualificationRatePct.toFixed(1)}%
                    <div className="mt-1 h-2 w-full rounded bg-slate-700">
                      <div className="h-2 rounded bg-emerald-950/400" style={{ width: `${clampPct(pipelineFunnelDiagnostics.qualificationRatePct)}%` }} />
                    </div>
                  </div>
                  <div>
                    Final combo conversion rate: {pipelineFunnelDiagnostics.finalComboConversionRatePct.toFixed(1)}%
                    <div className="mt-1 h-2 w-full rounded bg-slate-700">
                      <div className="h-2 rounded bg-amber-950/400" style={{ width: `${clampPct(pipelineFunnelDiagnostics.finalComboConversionRatePct)}%` }} />
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                  <p className="font-medium text-slate-100">Pertes par étape</p>
                  <div className="mt-2 space-y-2 text-xs text-slate-300">
                    {pipelineFunnelDiagnostics.stageLossRows.map((row) => (
                      <div key={`stage-loss-${row.from}-${row.to}`} className="rounded border border-slate-700 bg-slate-900 p-2">
                        <div className="flex items-center justify-between">
                          <span>{row.from} → {row.to}</span>
                          <span className="font-medium">{row.before} → {row.after} (perte {row.lost})</span>
                        </div>
                        <div className="mt-1 h-2 w-full rounded bg-slate-700">
                          <div className="h-2 rounded bg-slate-600" style={{ width: `${clampPct(row.conversionPct)}%` }} />
                        </div>
                        <div className="mt-1 text-right">{row.conversionPct.toFixed(1)}%</div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                  <p className="font-medium text-slate-100">Rejection Dashboard</p>
                  {pipelineFunnelDiagnostics.rejectionRows.length === 0 ? (
                    <p className="mt-2 text-xs text-slate-500">Aucun rejet comptabilisé.</p>
                  ) : (
                    <div className="mt-2 overflow-x-auto">
                      <table className="min-w-full text-left text-xs text-slate-300">
                        <thead>
                          <tr className="border-b border-slate-700 text-slate-500">
                            <th className="py-1 pr-2 font-medium">Reason</th>
                            <th className="py-1 pr-2 font-medium">Count</th>
                            <th className="py-1 font-medium">Severity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pipelineFunnelDiagnostics.rejectionRows.map((row) => (
                            <tr key={`reject-row-${row.reason}`} className="border-b border-slate-800 last:border-0">
                              <td className="py-1 pr-2">{row.reason}</td>
                              <td className="py-1 pr-2">{row.count}</td>
                              <td className="py-1">{row.severity}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <div className="mt-3 rounded border border-slate-700 bg-slate-900 p-2 text-xs">
                    <div className="font-medium text-slate-200">Yahoo qualification reasons</div>
                    <div className="mt-1 text-slate-400">
                      no_put_below_lower_bound: {pipelineFunnelDiagnostics.reasonBreakdown.no_put_below_lower_bound} ·
                      no_liquid_strike_below_lower_bound: {pipelineFunnelDiagnostics.reasonBreakdown.no_liquid_strike_below_lower_bound} ·
                      premium_below_target: {pipelineFunnelDiagnostics.reasonBreakdown.premium_below_target} ·
                      yield_below_target: {pipelineFunnelDiagnostics.reasonBreakdown.yield_below_target} ·
                      safe_strike_not_liquid: {pipelineFunnelDiagnostics.reasonBreakdown.safe_strike_not_liquid} ·
                      failed_final_filter: {pipelineFunnelDiagnostics.reasonBreakdown.failed_final_filter} ·
                      unknown: {pipelineFunnelDiagnostics.reasonBreakdown.unknown}
                    </div>
                  </div>
                </div>
              </div>

              {pipelineFunnelDiagnostics.watchlistBuildRejections.length > 0 && (
                <div className="mt-3 rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                  <p className="font-medium text-slate-100">Watchlist build rejection reasons</p>
                  <div className="mt-2 grid gap-1 text-xs text-slate-300 md:grid-cols-2">
                    {pipelineFunnelDiagnostics.watchlistBuildRejections.map((row) => (
                      <div key={`watchlist-build-reason-${row.reason}`}>
                        {formatIbkrReason(row.reason)} : {row.count}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <YahooIbkrFunnelPanel
                rows={yahooIbkrFunnelList}
                summary={yahooIbkrFunnelSummary}
                topN={topN}
                ibkrSentCount={ibkrSentCount}
                onExportCsv={exportYahooIbkrFunnelCsv}
              />
            </details>
          </div>
        )}

        {(Number(yahooScanMeta.scanned) > 0 || yahooRejectedCount > 0) && (
          <div className="mb-6 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300 shadow-sm">
            <details>
              <summary className="cursor-pointer font-semibold text-slate-100">
                Diagnostic Yahoo (dernier scan)
              </summary>
              <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
                <Metric label="Yahoo scanned" value={String(yahooScanMeta.scanned || 0)} />
                <Metric label="Yahoo kept" value={String(yahooScanMeta.kept || 0)} />
                <Metric label="Yahoo returned" value={String(yahooScanMeta.returned || 0)} />
                <Metric label="Yahoo rejected" value={String(yahooRejectedCount)} />
              </div>
              <p className="mt-2 text-xs text-slate-400">
                Index complet rejets Yahoo : {Object.keys(yahooRejectedBySymbol || {}).length} symboles
                (utilisé par le diagnostic ticker exact — indépendant de l&apos;échantillon 20).
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                  <p className="font-medium text-slate-100">Top rejectionReasonCounts</p>
                  {yahooTopRejectionReasons.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">Aucun détail disponible.</p>
                  ) : (
                    <div className="mt-2 space-y-1 text-xs text-slate-300">
                      {yahooTopRejectionReasons.map((row) => (
                        <div key={`yahoo-reason-${row.reason}`}>
                          {formatIbkrReason(row.reason)} : {row.count}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                  <p className="font-medium text-slate-100">Top stageRejectCounts</p>
                  {yahooTopStageRejectCounts.length === 0 ? (
                    <p className="mt-1 text-xs text-slate-500">Aucun détail disponible.</p>
                  ) : (
                    <div className="mt-2 space-y-1 text-xs text-slate-300">
                      {yahooTopStageRejectCounts.map((row) => (
                        <div key={`yahoo-stage-${row.reason}`}>
                          {formatIbkrReason(row.reason)} : {row.count}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <div className="mt-3 rounded-xl border border-slate-700 bg-slate-800/50 p-3">
                <p className="font-medium text-slate-100">Exemples rejetés (max 20)</p>
                {yahooRejectedSampleRows.length === 0 ? (
                  <p className="mt-1 text-xs text-slate-500">Aucun exemple disponible.</p>
                ) : (
                  <div className="mt-2 space-y-1 text-xs text-slate-300">
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
          <div className="mb-6 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300 shadow-sm">
            <details>
              <summary className="cursor-pointer font-semibold text-slate-100">Candidats Yahoo non envoyés à IBKR</summary>
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
          <div className="mb-6 rounded-2xl border border-slate-700 bg-slate-900 p-4 text-sm text-slate-300 shadow-sm">
            <details>
              <summary className="cursor-pointer font-semibold text-slate-100">
                Rangs Yahoo — testés IBKR : {ibkrTestedCount} / {yahooReturnedCount}
              </summary>
            <p className="mt-1 text-xs text-slate-500">
              Source :{" "}
              <span className="font-mono font-medium text-slate-200">
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

        <details className="mb-6 rounded-[28px] border border-slate-700 bg-slate-900 p-5 text-sm text-slate-400 shadow-sm">
          <summary className="cursor-pointer text-base font-semibold text-slate-100">
            Diagnostics IBKR avancés
          </summary>
          <div className="mt-4 space-y-6">
            <details className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4">
              <summary className="cursor-pointer font-semibold text-slate-100">
                Compteurs appels Yahoo / IBKR
              </summary>
              <div className="mt-3 space-y-3 text-sm text-slate-300">
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
                  <div className="rounded-xl border border-amber-800 bg-amber-950/40 p-3 text-amber-300">
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
                        label="IBKR put contracts théoriques"
                        value={String(scanMetricsData?.ibkr?.totals?.totalPutCandidateContractsRequested ?? 0)}
                      />
                      <Metric
                        label="IBKR put contracts réellement demandées"
                        value={String(
                          scanMetricsData?.ibkr?.totals?.totalPutCandidateContractsActuallyRequested ?? 0
                        )}
                      />
                      <Metric
                        label="IBKR put quotes évitées (quick gate)"
                        value={String(scanMetricsData?.ibkr?.totals?.totalPutQuotesAvoidedByQuickGate ?? 0)}
                      />
                      <Metric
                        label="Quick gate — ignorés (gate OFF)"
                        value={String(scanMetricsData?.ibkr?.totals?.totalQuickGateSkipped ?? 0)}
                      />
                      <Metric
                        label="Quick gate — évalués"
                        value={String(scanMetricsData?.ibkr?.totals?.totalQuickGateEvaluated ?? 0)}
                      />
                      <Metric
                        label="Quick gate — passés"
                        value={String(scanMetricsData?.ibkr?.totals?.totalQuickGatePassed ?? 0)}
                      />
                      <Metric
                        label="Quick gate — fallback"
                        value={String(scanMetricsData?.ibkr?.totals?.totalQuickGateFallback ?? 0)}
                      />
                      <Metric
                        label="Quick gate — rejetés rapides"
                        value={String(scanMetricsData?.ibkr?.totals?.totalQuickGateRejected ?? 0)}
                      />
                      <Metric
                        label="Quick gate — appels économisés (approx)"
                        value={String(scanMetricsData?.ibkr?.totals?.totalQuickGateSavedApproxCalls ?? 0)}
                      />
                      <Metric
                        label="Quick gate — état"
                        value={
                          scanMetricsData?.ibkr?.quickPremiumGateEnabled === true
                            ? "ON"
                            : scanMetricsData?.ibkr?.quickPremiumGateEnabled === false
                              ? "OFF"
                              : "—"
                        }
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
                    <div className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <p className="font-medium text-slate-100">Top 5 tickers IBKR les plus coûteux</p>
                      {ibkrTopCostlySymbols.length === 0 ? (
                        <p className="mt-1 text-slate-500">Aucune donnée ticker disponible.</p>
                      ) : (
                        <div className="mt-2 space-y-1 text-xs text-slate-300">
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
                    <details className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                      <summary className="cursor-pointer font-medium text-slate-100">
                        Détail IBKR par ticker
                      </summary>
                      <p className="mt-2 text-xs leading-5 text-slate-500">
                        IBKR est plus lent que Yahoo : surveiller surtout durée, option qualify et option market data.
                      </p>
                      {ibkrTickerDetailRows.length === 0 ? (
                        <p className="mt-2 text-slate-500">Aucun détail IBKR par ticker disponible.</p>
                      ) : (
                        <div className="mt-3 overflow-x-auto">
                          <table className="min-w-full text-left text-xs text-slate-300">
                            <thead className="border-b border-slate-700 text-slate-500">
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
                                <tr key={`ibkr-detail-${row.symbol}`} className="border-b border-slate-800 last:border-0">
                                  <td className="py-2 pr-4 font-semibold text-slate-100">{row.symbol}</td>
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
                  <details className="rounded-xl border border-slate-700 bg-slate-900 p-3">
                    <summary className="cursor-pointer font-medium text-slate-100">
                      Détail IBKR par ticker
                    </summary>
                    <p className="mt-2 text-xs leading-5 text-slate-500">
                      IBKR est plus lent que Yahoo : surveiller surtout durée, option qualify et option market data.
                    </p>
                    <div className="mt-3 overflow-x-auto">
                      <table className="min-w-full text-left text-xs text-slate-300">
                        <thead className="border-b border-slate-700 text-slate-500">
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
                            <tr key={`ibkr-detail-fallback-${row.symbol}`} className="border-b border-slate-800 last:border-0">
                              <td className="py-2 pr-4 font-semibold text-slate-100">{row.symbol}</td>
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

            <details className="mb-6 rounded-[28px] border border-slate-700 bg-slate-900 p-4 shadow-sm">
              <summary className="cursor-pointer text-base font-semibold text-slate-100">
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

        <Card className="mb-6 rounded-[28px] border-slate-700 shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-xl text-slate-100">IBKR Shadow Batch — Diagnostic</CardTitle>
            <p className="mt-1 text-sm text-slate-500">
              IBKR Shadow Batch est en lecture seule. Aucun ordre envoyé. Les données peuvent être
              frozen/delayed hors marché.
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Expiration utilisée pour IBKR :{" "}
              <span className="font-medium text-slate-300">
                {(ibkrBatchExpirationInfo.usedExpiration || "—")} /{" "}
                {(ibkrBatchExpirationInfo.ibkrExpiration || "—")}
              </span>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Titres envoyés :{" "}
              <span className="font-medium text-slate-300">
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
                <label className="mb-2 block text-sm font-medium text-slate-300">Client ID start</label>
                <Input
                  type="number"
                  value={ibkrBatchClientIdStart}
                  onChange={(e) => setIbkrBatchClientIdStart(e.target.value)}
                  className="w-full rounded-xl border-slate-700"
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
              <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-300">
                Validation IBKR Shadow en cours…
              </div>
            )}

            {ibkrBatchError && (
              <div className="rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-400">
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

                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4 text-sm text-slate-300">
                  <p className="mb-2 font-medium text-slate-100">Résultats compacts</p>
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
          yahooReturnedCandidates={yahooReturnedCandidates}
          yahooRankForIbkrBySymbol={yahooRankForIbkrBySymbol}
          yahooScanTiming={yahooScanTiming}
          onRun={handleIbkrDirectScan}
          onRunTest={handleIbkrDirectTestScan}
        />

        <details className="mb-6 rounded-[28px] border border-slate-700 bg-slate-900 p-4 text-sm text-slate-400 shadow-sm">
          <summary className="cursor-pointer font-semibold text-slate-100">
            Diagnostic secondaire : ancienne vue fusionnée
          </summary>
          <div className="mt-4">
            <MergedShortlistSection candidates={mergedIbkrYahooCandidatesForPanel} />
          </div>
        </details>
          </div>
        </details>
        </DiagnosticsSection>
        <DiagnosticsSection
          title="Mémoire IBKR & Archive Funnel"
          description="Historique read-only des scans IBKR et des sessions de funnel archivées."
        >
          <IbkrMemoryPanel apiBase={API_BASE} refreshKey={ibkrMemoryRefreshKey} />
          <ScanFunnelArchivePanel apiBase={API_BASE} />
        </DiagnosticsSection>
          </section>
        ) : activeView === "ticker" ? (
          <section className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5 shadow-xl">
              <p className="text-xs font-semibold uppercase tracking-[0.22em] text-sky-300">
                Ticker
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-white">Analyse titre</h1>
              <p className="mt-2 text-sm text-slate-300">
                Fiche individuelle d'un symbole. Recherche d'abord dans le dernier scan, puis scan manuel possible si absent.
              </p>
              <p className="mt-1 text-xs text-sky-300/70">
                Lecture seule — aucun ordre envoyé.
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 shadow-sm">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={tickerInput}
                    onChange={(e) => setTickerInput(String(e.target.value || "").toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSearchTicker();
                    }}
                    placeholder="Ex. TQQQ"
                    className="rounded-xl border-slate-700 pl-9 uppercase"
                  />
                </div>
                <Button
                  className="shrink-0 rounded-xl border-sky-700 bg-sky-900 px-4 py-1.5 text-xs text-sky-100 hover:bg-sky-800"
                  onClick={handleSearchTicker}
                >
                  Rechercher <Search className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
              <p className="mt-2 text-xs text-slate-500">
                La recherche interroge uniquement les données déjà chargées (dernier scan). Aucun appel réseau, aucun scan automatique.
              </p>
            </div>

            {(() => {
              if (!tickerActive) {
                return (
                  <div className="rounded-2xl border border-dashed border-slate-700 bg-slate-900/40 p-8 text-center text-sm text-slate-400">
                    Entre un symbole pour analyser son état dans le dernier scan.
                  </div>
                );
              }

              const match = findTickerInCurrentScan(tickerActive);
              if (match) {
                const decision = buildTickerDecision(match.data);
                if (!decision) {
                  return (
                    <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-sm">
                      <p className="text-sm text-slate-500">
                        Aucun champ exploitable disponible pour {tickerActive} dans le dernier scan.
                      </p>
                    </div>
                  );
                }
                return (
                  <TickerDecisionCard
                    decision={decision}
                    source={match.source}
                    heading="Résumé du dernier scan"
                    rawObj={match.data}
                  />
                );
              }

              return (
                <div className="rounded-2xl border border-slate-700 bg-slate-900 p-5 shadow-sm">
                  <p className="text-sm text-slate-200">
                    <span className="font-semibold text-slate-50">{tickerActive}</span>{" "}
                    n'est pas présent dans le dernier scan.
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Scan lecture seule via IBKR Shadow. N'affecte pas la shortlist Opportunités.
                  </p>
                  <Button
                    className="mt-3 rounded-xl border-emerald-700 bg-emerald-900/60 px-4 py-1.5 text-xs text-emerald-100 hover:bg-emerald-800/60 disabled:opacity-50"
                    onClick={handleScanSingleTicker}
                    disabled={tickerScanLoading}
                  >
                    {tickerScanLoading ? "Scan en cours…" : "Scanner ce ticker"}
                    {!tickerScanLoading && <RefreshCw className="ml-1.5 h-4 w-4" />}
                  </Button>
                  <p className="mt-2 text-[11px] text-slate-500">
                    Endpoint réutilisé : /ibkr/shadow/scan (shadow, lecture seule) · expiration {selectedExpiration}.
                  </p>

                  {tickerScanError && (
                    <p className="mt-3 rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">
                      {tickerScanError}
                    </p>
                  )}

                  {tickerScanResult && tickerScanResult.symbol === tickerActive && (() => {
                    const payload = tickerScanResult.payload || {};
                    const up = (v) => String(v ?? "").trim().toUpperCase();
                    const shortlist = Array.isArray(payload.shortlist) ? payload.shortlist : [];
                    const rejected = Array.isArray(payload.rejected) ? payload.rejected : [];
                    const keptRow = shortlist.find((r) => up(r?.symbol) === tickerActive);
                    const rejRow = rejected.find((r) => up(r?.symbol) === tickerActive);
                    const row = keptRow ?? rejRow ?? null;
                    const statusLabel = keptRow ? "Retenu" : rejRow ? "Rejeté" : "Aucun résultat";
                    const statusTone = keptRow ? "green" : rejRow ? "red" : "gray";
                    const decision = row ? buildTickerDecision(row) : null;
                    if (decision && decision.expiration == null) {
                      decision.expiration = tickerScanResult.expiration; // expiration réellement scannée
                    }
                    return (
                      <div className="mt-4">
                        {decision ? (
                          <TickerDecisionCard
                            decision={decision}
                            source="IBKR Shadow"
                            heading="Résultat du scan individuel"
                            statusLabel={statusLabel}
                            statusTone={statusTone}
                            rawObj={row}
                          />
                        ) : (
                          <div className="rounded-xl border border-slate-700 bg-slate-950/60 p-4">
                            <div className="flex items-center justify-between gap-3">
                              <p className="text-xs uppercase tracking-wide text-slate-500">
                                Résultat du scan individuel
                              </p>
                              <TickerBadge tone={statusTone}>{statusLabel}</TickerBadge>
                            </div>
                            <p className="mt-3 text-sm text-slate-400">
                              Le scan n'a retourné aucune ligne exploitable pour {tickerActive}
                              {Array.isArray(payload.errors) && payload.errors.length > 0
                                ? " (voir erreurs backend)."
                                : "."}
                            </p>
                            <p className="mt-2 text-[11px] text-slate-500">
                              Source : IBKR Shadow · lecture seule.
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </div>
              );
            })()}

            {tickerActive && (
              <TickerPipelineStagesCard view={tickerPipelineView} symbol={tickerActive} />
            )}
          </section>
        ) : activeView === "dashboard" ? (
          <>
            <div id="section-scan" className="mb-4 scroll-mt-4 rounded-2xl border border-[rgba(110,150,190,0.20)] bg-[#0b1a2b] p-2.5 shadow-[0_10px_40px_rgba(0,0,0,0.35)]">
          {/* En-tête compact « trading terminal » : une seule ligne de contrôles + une micro-ligne d'état. */}
          {/* Ligne principale de contrôles : groupe gauche wrappable + Refresh/⋯ épinglés à droite,
              alignés sur la première ligne (items-start) pour ne pas « flotter » hors barre. */}
          <div className="flex min-w-0 flex-nowrap items-start gap-1.5">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <span className="mr-1 shrink-0 text-sm font-semibold tracking-tight text-[#f4f7fb]">Opportunités</span>
            <EditableScanSelect
              label="Exp."
              value={selectedExpiration}
              onChange={(e) => setSelectedExpiration(e.target.value)}
              title="Expiration utilisée pour le scan backend."
              wrapperClassName="w-[150px] shrink-0"
            >
              {expirationOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </EditableScanSelect>

            <EditableScanInput
              label="Capital"
              value={capital}
              onChange={(e) => setCapital(Number(e.target.value || 0))}
              min={1000}
              step={100}
              suffix="$"
              inputClassName="w-[70px] min-w-0"
              wrapperClassName="w-[150px] shrink-0"
              title="Capital compte utilisé par les moteurs de combinaisons."
            />

            <EditableScanInput
              label="Max"
              value={maxCapitalPct}
              onChange={(e) => setMaxCapitalPct(Number(e.target.value || 0))}
              min={10}
              max={100}
              suffix="%"
              inputClassName="w-[42px] min-w-0"
              wrapperClassName="w-[95px] shrink-0"
              title="% maximal du capital utilisé."
            />

            <EditableScanInput
              label="Positions"
              value={maxPositions}
              onChange={(e) => setMaxPositions(Number(e.target.value || 1))}
              min={1}
              max={10}
              wrapperClassName="w-[125px] shrink-0"
              title="Nombre maximal de positions visées."
            />

            <LockedScanBadge
              label="IBKR"
              value="ON 🔒"
              title="IBKR auto verrouillé ON dans le workflow principal."
              wrapperClassName="shrink-0"
            />

            <EditableScanSelect
              label="POP"
              value={autoJournalPop === "off" ? "off" : "on"}
              onChange={(e) =>
                setAutoJournalPop(e.target.value === "on" ? "200" : "off")
              }
              title={
                autoJournalPop === "off"
                  ? "Journal POP OFF : aucune capture automatique."
                  : `Journal POP ON : capture tous les retenus IBKR disponibles (max 200)${
                      lastScanPoolMeta?.ibkrRetained
                        ? ` (${lastScanPoolMeta.ibkrRetained} retenus IBKR au dernier scan)`
                        : ""
                    }.`
              }
              wrapperClassName="w-[95px] shrink-0"
            >
              <option value="off">OFF</option>
              <option value="on">ON</option>
            </EditableScanSelect>

            <EditableScanInput
              label="Depth"
              value={ibkrAutoMaxTickers}
              onChange={(e) => setIbkrAutoMaxTickers(Number(e.target.value || 0))}
              min={1}
              list="scan-depth-suggestions"
              wrapperClassName="w-[105px] shrink-0"
              title="IBKR Audit Depth — nombre de tickers audités via IBKR."
            />
            <datalist id="scan-depth-suggestions">
              <option value="10" />
              <option value="20" />
              <option value="30" />
              <option value="50" />
              <option value="120" />
            </datalist>

            <EditableScanSelect
              label="Pool"
              value={preIbkrPoolMode}
              onChange={(e) => setPreIbkrPoolMode(e.target.value)}
              title="Pool pré-IBKR utilisé avant l'audit IBKR."
              wrapperClassName="w-[125px] shrink-0"
            >
              <option value="strict_watchlist">Strict</option>
              <option value="research_expanded">Research</option>
              <option value="fallback_65">Fallback</option>
            </EditableScanSelect>

            <EditableScanSelect
              label="OTM"
              value={String(watchlistOtmProbePct)}
              onChange={(e) => setWatchlistOtmProbePct(Number(e.target.value))}
              title="Sonde liquidité OTM Yahoo appliquée au prochain « Rebuild watchlist » (0 % = ATM seulement)."
              wrapperClassName="w-[90px] shrink-0"
            >
              {LIQUIDITY_OTM_PROBE_PCT_CHOICES.map((p) => (
                <option key={p} value={String(p)}>
                  {p}%
                </option>
              ))}
            </EditableScanSelect>

            <EditableScanInput
              label="Yahoo"
              value={topN}
              onChange={(e) => setTopN(Number(e.target.value || 1))}
              min={1}
              max={200}
              wrapperClassName="w-[105px] shrink-0"
              title="Limite Yahoo — nombre maximal de candidats Yahoo gardés avant test IBKR."
            />

            {refreshStage ? (
              <ScanCompactBadge label="État" value={refreshStage} />
            ) : null}

            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                title={
                  scanBlockedByClosedExpiration
                    ? "Expiration fermée sans date ajustée valide — scan bloqué."
                    : "Rafraîchir la shortlist (scan)"
                }
                className="shrink-0 rounded-xl border-emerald-600 bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-600"
                onClick={handleRefreshShortlist}
                disabled={loadingScan || watchlistLoading || ibkrDirectLoading || scanBlockedByClosedExpiration}
              >
                <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh shortlist
              </Button>
              <details className="relative shrink-0">
                <summary
                  title="Actions secondaires · Détails scan"
                  className="inline-flex cursor-pointer list-none items-center rounded-lg border border-[rgba(110,150,190,0.25)] bg-transparent px-2 py-1.5 text-[11px] font-medium text-[#7f97b6] hover:text-[#cfe0f2] [&::-webkit-details-marker]:hidden"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </summary>
                <div className="absolute right-0 z-20 mt-1 w-72 rounded-lg border border-[rgba(110,150,190,0.25)] bg-[#0d2034] p-2 shadow-[0_10px_30px_rgba(0,0,0,0.45)]">
                  <Button
                    title="Rebuild watchlist (action secondaire)"
                    className="w-full justify-start rounded-md border-0 bg-transparent px-2 py-1.5 text-[11px] font-medium text-[#cfe0f2] hover:bg-[#0b1a2b]"
                    variant="outline"
                    onClick={handleRebuildWatchlist}
                    disabled={loadingScan || watchlistLoading || ibkrDirectLoading}
                  >
                    <Database className="mr-1.5 h-3.5 w-3.5" /> Rebuild watchlist
                  </Button>
                  <div className="mt-2 space-y-1.5 border-t border-[rgba(110,150,190,0.18)] pt-2 text-[11px] leading-snug text-[#91a8c4]">
                    <p className="font-semibold uppercase tracking-wide text-[#7f97b6]">Détails scan</p>
                    <p>
                      <span className="text-[#7f97b6]">Source : </span>
                      {dataSource === "ibkr_direct"
                        ? `IBKR Direct Scan${primaryIbkrSourceInfo?.twoPhaseEnabled ? " · 2 phases officiel" : ""}`
                        : dataSource === "backend"
                        ? "backend local /scan_shortlist"
                        : "snapshot local (fallback)"}
                    </p>
                    <p>
                      <span className="text-[#7f97b6]">Pool actif : </span>
                      {getPoolModeLabel(preIbkrPoolMode)} — {currentPoolCount} tickers
                    </p>
                    {showClosedNoCacheBanner ? (
                      <p className="text-amber-300">
                        Snapshot fallback — marché fermé et aucun scan valide en cache local.
                      </p>
                    ) : null}
                    {selectedExpirationClosedInfo ? (
                      <p className={selectedExpirationClosedInfo.blocked ? "text-rose-300" : "text-amber-300"}>
                        {selectedExpirationClosedInfo.message}
                      </p>
                    ) : null}
                    {watchlistTickers?.length === 0 && preIbkrPoolMode === "fallback_65" ? (
                      <p className="text-amber-300">
                        ⚠ Watchlist vide — utilisation fallback 65. IBKR Audit Depth ne pourra pas dépasser ~65.
                      </p>
                    ) : null}
                    {otmRebuildRequired && otmRebuildRequiredMessage ? (
                      <p className="text-amber-200" data-testid="otm-rebuild-required-banner">
                        {otmRebuildRequiredMessage}
                      </p>
                    ) : null}
                    {otmPoolSourceBannerMessage ? (
                      <p
                        className={
                          preIbkrPoolMode === "research_expanded" ||
                          lastScanPoolMeta.poolSource === "research_expanded"
                            ? "text-amber-200"
                            : "text-sky-200"
                        }
                        data-testid="otm-pool-source-banner"
                      >
                        {otmPoolSourceBannerMessage}
                      </p>
                    ) : null}
                  </div>
                </div>
              </details>
            </div>
          </div>

          {/* Micro-ligne d'état secondaire — dense, style terminal. */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-[11px] leading-tight text-[#7f97b6]">
            {(() => {
              const segs = [];
              segs.push(
                dataSource === "ibkr_direct"
                  ? `IBKR Direct Scan${primaryIbkrSourceInfo?.twoPhaseEnabled ? " · 2 phases" : ""}`
                  : dataSource === "backend"
                  ? "backend local"
                  : "snapshot local"
              );
              segs.push(marketClosedNow ? "Marché fermé" : "Marché ouvert");
              if (selectedExpiration) segs.push(`Exp réelle ${selectedExpiration}`);
              segs.push(`Pool ${getPoolModeLabel(preIbkrPoolMode)} · ${currentPoolCount} tickers`);
              return segs.map((seg, i) => (
                <React.Fragment key={i}>
                  {i > 0 ? <span className="text-[#46607e]">·</span> : null}
                  <span className="text-[#91a8c4]">{seg}</span>
                </React.Fragment>
              ));
            })()}
            {dataSource === "ibkr_direct" || dataSource === "backend" ? (
              <span
                title={`${scanMeta.kept} retenus IBKR sur ${scanMeta.scanned} scannés`}
                className="inline-flex items-center rounded-full border border-[rgba(110,150,190,0.20)] bg-[#0d2034] px-1.5 py-0.5 font-medium text-[#22e36f]"
              >
                {scanMeta.kept}/{scanMeta.scanned} IBKR
              </span>
            ) : null}
            {lastScanPoolStale ? (
              <span className="inline-flex items-center rounded-full border border-amber-700/60 bg-amber-950/40 px-1.5 py-0.5 font-medium text-amber-200">
                Mode changé — Refresh
              </span>
            ) : null}
          </div>

          {/* Patch 3A — contrôles research conservés, visibles seulement en mode Research Expanded. */}
          {preIbkrPoolMode === "research_expanded" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <EditableScanSelect
                label="Research limit"
                value={String(researchExpandedLimit)}
                onChange={(e) => setResearchExpandedLimit(readStoredResearchExpandedLimit(e.target.value))}
                title="Plafond du pool Research Expanded."
              >
                <option value="150">150</option>
                <option value="200">200</option>
              </EditableScanSelect>
              <Button
                type="button"
                variant="outline"
                className="rounded-lg border-slate-600 bg-slate-800 text-xs text-slate-200"
                onClick={handleReloadResearchExpandedPool}
                disabled={researchExpandedPoolSource === "loading"}
              >
                Recharger pool research
              </Button>
              <span className="text-xs text-slate-500">
                Pool research chargé :{" "}
                {researchExpandedPoolSource === "loading"
                  ? "…"
                  : `${researchExpandedPool.length} tickers (${researchExpandedPoolSource})`}
              </span>
              {researchExpandedPoolError ? (
                <span className="text-xs text-amber-300">{researchExpandedPoolError}</span>
              ) : null}
            </div>
          )}
        </div>
        <div id="section-diagnostics" className="scroll-mt-4" />

        {watchlistBuildError && watchlistSource === "fallback" && (
          <div className="mb-6 rounded-2xl border border-amber-800 bg-amber-950/40 p-4 text-sm text-amber-300 shadow-sm">
            Watchlist : secours liste statique ({FALLBACK_TICKERS.length} tickers). Raison : {watchlistBuildError}
          </div>
        )}

        {(watchlistLoading || loadingScan) && (
          <div className="mb-6 rounded-2xl border border-slate-700 bg-slate-900 p-4 shadow-sm">
            <div className="flex items-center justify-between text-sm text-slate-300">
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
            {/* Bannière info unique compacte — remplace les multiples bandeaux DEV / marché / source. */}
            {(showClosedValidBanner || showIndicativeClosedBanner || showSourceStatusBanner) && (() => {
              const isIndicative = showIndicativeClosedBanner || showClosedValidBanner || backendShortlistDevScan;
              const segments = [];
              if (isIndicative) segments.push("Données indicatives uniquement (DEV)");
              segments.push(marketClosedNow ? "Marché fermé" : "Marché ouvert");
              if (selectedExpiration) segments.push(`Réelle : ${selectedExpiration}`);
              if (dataSource === "ibkr_direct" || dataSource === "backend") {
                segments.push(`${scanMeta.kept} retenus IBKR sur ${scanMeta.scanned} scannés`);
              } else {
                segments.push("snapshot local (fallback)");
              }
              return (
                <div className="mb-4 flex items-center gap-2 rounded-xl border border-[rgba(110,150,190,0.20)] bg-[#0b1a2b] px-3 py-2 text-xs text-[#91a8c4] shadow-sm">
                  <Info className="h-3.5 w-3.5 shrink-0 text-[#19a7ff]" />
                  <span className="leading-tight">
                    {segments.map((seg, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <span className="mx-1.5 text-[#46607e]">·</span>}
                        <span className={i === 0 && isIndicative ? "font-semibold text-[#ffd166]" : "text-[#cfe0f2]"}>{seg}</span>
                      </React.Fragment>
                    ))}
                  </span>
                </div>
              );
            })()}

            {/* Détail « Snapshot fallback » retiré de la vue principale — info essentielle
                déjà portée par la micro-ligne d'en-tête ; détail technique déplacé dans ⋯ / Détails scan. */}

            {scanError && !showClosedNoCacheBanner && (
              <div className="mb-6 rounded-2xl border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-400 shadow-sm">
                {scanError}
              </div>
            )}
          </>
        )}


        <div id="section-opportunites" className="space-y-6 scroll-mt-4">
          <div className="space-y-6">
            <Card className="rounded-[28px] border-[rgba(110,150,190,0.20)] bg-[#0b1a2b] shadow-[0_18px_60px_rgba(0,0,0,0.40)]">
              {/* Toolbar compacte : recherche + filtres + tri. Le titre « Classement crème de la crème »
                  est porté par le panneau ci-dessous (évite le double titre). */}
              <CardHeader className="pb-2">
                <div className="flex w-full flex-col gap-2 lg:flex-row lg:flex-wrap lg:items-center">
                  <div className="relative min-w-[200px] flex-1">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Ticker ou nom..."
                      className="rounded-xl border-slate-700 pl-9"
                    />
                    <TickerPipelineDiagnosticPanel diagnostic={pipelineTickerDiagnostic} />
                  </div>

                  {/* Filtre Mode — basé sur le mode réellement affiché par ligne (finalDisplayMode).
                      BALANCED strike leg future phase — do not expose as line filter until backend
                      provides a real balanced leg. Les buckets Top/Favoris/Autres/Rejetés restent
                      les filtres principaux du classement. */}
                  <Select
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                    className="rounded-xl border-slate-700"
                    title="Filtre Mode — affiche uniquement les lignes dont le mode retenu correspond (SAFE / AGRESSIF)."
                  >
                    <option value="all">Mode: Tous</option>
                    <option value="SAFE">Mode: SAFE</option>
                    <option value="AGGRESSIVE">Mode: AGRESSIF</option>
                  </Select>
                  <Select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    className="rounded-xl border-slate-700"
                  >
                    <option value="quality">Trier par: qualité Wheel</option>
                    <option value="strikeDistance">Trier par: distance strike</option>
                    <option value="weeklyReturn">Trier par: rendement hebdo</option>
                    <option value="spread">Trier par: spread</option>
                  </Select>
                  <Select
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                    className="rounded-xl border-slate-700"
                  >
                    <option value="asc">Ordre: asc</option>
                    <option value="desc">Ordre: desc</option>
                  </Select>
                </div>
              </CardHeader>

              <CardContent className="px-2 py-3 md:px-3">
                {filtered.length === 0 ? (
                  <div className="rounded-2xl border border-dashed border-slate-600 bg-slate-800/50 p-10 text-center text-sm text-slate-500">
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
                      sortBy={sortBy}
                    />
                    <p className="mt-3 px-1 text-xs text-slate-500">
                      Les cryptos exclus sont masqués du classement principal. Ils ne sont pas encore remplacés automatiquement par les prochains candidats Yahoo.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>

            <div id="section-portefeuille" className="scroll-mt-4" />
            <PortfolioCombos
              combos={combos}
              candidates={filtered}
              capital={Number(capital)}
              maxCapitalPct={Number(maxCapitalPct)}
              maxPositions={Number(maxPositions)}
              onTickerClick={scrollToTickerCard}
              ibkrRejectedSymbols={ibkrRejectedSymbols}
            />
          </div>

          {/* Sections secondaires repliées par défaut : restent accessibles sans alourdir la vue compacte. */}
          <details className="space-y-4">
            <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-xl border border-[rgba(110,150,190,0.20)] bg-[#0b1a2b] px-3 py-2 text-xs font-medium text-[#cfe0f2] hover:text-white [&::-webkit-details-marker]:hidden">
              <Activity className="h-4 w-4 text-[#19a7ff]" />
              Alertes, règles & résumé semaine
              <span className="text-[#46607e]">— afficher</span>
            </summary>
            <div className="mt-4 space-y-6">
            <AlertPanel />

            <Card className="rounded-[28px] border-[rgba(110,150,190,0.20)] bg-[#0b1a2b] shadow-[0_18px_60px_rgba(0,0,0,0.40)]">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-xl text-slate-100">
                  <Activity className="h-5 w-5" />
                  Résumé semaine
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 text-sm text-slate-400">
                <div className="rounded-2xl border border-slate-700 bg-slate-800/50 p-4">
                  <p className="font-medium text-slate-100">Lecture rapide</p>
                  <p className="mt-2 leading-6">
                    Le scan principal est calculé côté backend sur la watchlist chargée. Le frontend ne fait pas le scan ticker par ticker.
                  </p>
                </div>

                <div className="rounded-2xl border border-slate-700 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-500">Source active</span>
                    <span className="font-semibold text-slate-100">
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
                          <span className="font-semibold text-slate-100">{filtered.length}</span>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-slate-500">Admissibles panneau crème</span>
                          <span className="font-semibold text-slate-100">{admis}</span>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-slate-500">Exclus crypto masqués</span>
                          <span className="font-semibold text-slate-100">{cryptoCount}</span>
                        </div>
                        <div className="mt-3 flex items-center justify-between">
                          <span className="text-slate-500">Non remplacés après exclusion</span>
                          <span className="font-semibold text-amber-400">{cryptoCount}</span>
                        </div>
                      </>
                    );
                  })()}
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Scannés backend</span>
                    <span className="font-semibold text-slate-100">{scanMeta.scanned}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Retenus backend</span>
                    <span className="font-semibold text-slate-100">{scanMeta.kept}</span>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className="text-slate-500">Capital compte</span>
                    <span className="font-semibold text-slate-100">${Number(capital).toFixed(0)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
            </div>
          </details>
            </div>
          </>
        ) : (
          <React.Suspense
            fallback={
              <div className="rounded-[28px] border border-slate-700 bg-slate-900 p-8 text-sm text-slate-500 shadow-sm">
                Chargement du journal...
              </div>
            }
          >
            <JournalPopPanel apiBase={API_BASE} active={activeView === "journal"} />
          </React.Suspense>
        )}
      </div>

        </main>
      </div>
      <DetailModal
        item={selectedItem}
        seasonalityEntry={
          selectedItem
            ? seasonalityMap[String(selectedItem.ticker ?? "").trim().toUpperCase()] ?? null
            : null
        }
        onClose={() => setSelectedItem(null)}
      />
    </div>
  );
}
