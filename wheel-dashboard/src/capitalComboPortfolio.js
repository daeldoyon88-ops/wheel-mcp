/**
 * Moteur combinaisons capital — extrait de dashboard.jsx pour réutilisation Node (simulation) et React.
 * Ne fait aucun fetch réseau.
 */
import { getTickerDisplayMeta } from "./tickerMeta.js";
import {
  CAPITAL_COMBO_OPTIMIZER_DEFAULTS,
  getCapitalOptimizerV2Flags,
  mergeRejectionDiagnostics,
  compareLeftoverDensityOrder,
  computeLeftoverActionThresholdUsd,
  premiumDensityScore,
  buildNextBestResidualRows,
  summarizeBlockerHits,
  formatCapBlockerReason,
} from "./capitalComboEngineV2.js";
import { buildAlternativeCompositionSimV1 } from "./alternativeCompositionSimV1.js";

/** Spread IBKR : fraction 0–1 ou pourcentage déjà > 1. */
function normalizedIbkrSpreadPctPercent(raw) {
  const x = Number(raw);
  if (!Number.isFinite(x)) return null;
  if (x >= 0 && x <= 1.0001) return x * 100;
  return x;
}

function resolveOptimizerV2ForCombo(overrideFlags) {
  if (overrideFlags != null && typeof overrideFlags === "object") {
    return { ...CAPITAL_COMBO_OPTIMIZER_DEFAULTS, ...overrideFlags };
  }
  return getCapitalOptimizerV2Flags();
}

export function gradeLeg({ spreadPct, weeklyYieldPct, popDecimal }) {
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

export function getAggressivePriorityGrade({ spreadPct, weeklyYieldPct, popDecimal, distancePct }) {
  const spread = Number.isFinite(Number(spreadPct)) ? Number(spreadPct) : null;
  const yld = Number.isFinite(Number(weeklyYieldPct)) ? Number(weeklyYieldPct) : null;
  const popPct = Number.isFinite(Number(popDecimal)) ? Number(popDecimal) * 100 : null;
  const dist = Number.isFinite(Number(distancePct)) ? Number(distancePct) : null;
  if (spread == null || yld == null || popPct == null || dist == null) return null;
  if (yld < 0.90) return null;
  if (spread > 30) return null;
  if (popPct < 75) return null;
  if (dist > -5) return null;
  return spread <= 15 ? "A" : "B";
}

export const MODE_GRADE_RANK = {
  AGGRESSIVE_A: 8,
  AGGRESSIVE_B: 7,
  SAFE_A: 6,
  SAFE_B: 5,
  AGGRESSIVE_WATCH: 4,
  SAFE_WATCH: 3,
  WATCH: 2,
  REJECT: 0,
};

export function getModeGradeRank(mode, grade) {
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

/** Identifiant audit — BALANCED « Core Institutional Yield » (caps dynamiques, réversible). */
export const BALANCED_INSTITUTIONAL_V3_ID = "balanced-core-institutional-yield-v3";

/**
 * BALANCED V3 : plafond de lignes et caps qui montent avec le capital déployable,
 * sans toucher aux filtres SAFE / AGGRESSIVE ni au scanner.
 */
function computeBalancedInstitutionalV3(mode, usableCapital, globalMaxPositions) {
  const u = Number(usableCapital);
  const deploy = Number.isFinite(u) && u > 0 ? u : 0;
  const globalCap = Math.max(1, Number(globalMaxPositions) || 30);

  let targetLines = 6;
  if (deploy >= 27500) targetLines = 7;
  if (deploy >= 36000) targetLines = 8;
  if (deploy >= 48000) targetLines = Math.min(9, globalCap);
  const lineCap = Math.max(5, Math.min(globalCap, targetLines));

  let tickerCapPct = 0.32;
  let positionCapPct = 0.32;
  let maxContractsPerTicker = 4;
  let maxThemeCapitalPct = 0.48;
  let maxSectorCapitalPct = 0.48;
  let maxHighBetaCapitalPct = 0.38;
  let minTargetPositions = 3;

  /** Sous ~22,5k déployable : palier prudent (ex. petit compte ou maxCapitalPct bas). */
  if (deploy > 0 && deploy < 22500) {
    tickerCapPct = 0.3;
    positionCapPct = 0.3;
    maxContractsPerTicker = 3;
    maxThemeCapitalPct = 0.46;
    maxSectorCapitalPct = 0.46;
    maxHighBetaCapitalPct = 0.36;
    minTargetPositions = 3;
  } else if (deploy >= 22500) {
    minTargetPositions = deploy >= 32000 ? 4 : 3;
  }
  if (deploy >= 43000) {
    tickerCapPct = 0.34;
    positionCapPct = 0.34;
    maxThemeCapitalPct = 0.5;
    maxSectorCapitalPct = 0.5;
    maxHighBetaCapitalPct = 0.4;
  }

  const modePatch = {
    /** Légèrement sous 0.70 pour débloquer le pool sans rapprocher du profil AGGRESSIVE. */
    minWeeklyYield: 0.675,
    tickerCapPct,
    positionCapPct,
    maxContractsPerTicker,
    maxThemeCapitalPct,
    maxSectorCapitalPct,
    maxHighBetaCapitalPct,
    minTargetPositions,
    /** Spread légèrement assoupli vs 20% : reste sous AGGRESSIVE (25%). */
    maxSpreadPct: 22,
    /** Moins pénaliser la diversification statique du pool ; favoriser capital fit + yield modéré. */
    weights: {
      ...mode.weights,
      yield: 19,
      spread: mode.weights.spread,
      capitalFit: 12,
      diversificationPenalty: 4,
    },
  };

  return {
    modePatch,
    lineCap,
    audit: {
      engineId: BALANCED_INSTITUTIONAL_V3_ID,
      label: "Core Institutional Yield",
      usableCapitalUsd: deploy,
      effectiveMaxPositions: lineCap,
      minTargetPositionsBeforeStrictClusters: minTargetPositions,
      capsFraction: {
        tickerCap: tickerCapPct,
        positionCap: positionCapPct,
        maxTheme: maxThemeCapitalPct,
        maxSector: maxSectorCapitalPct,
        maxHighBeta: maxHighBetaCapitalPct,
      },
      maxContractsPerTicker,
      minWeeklyYieldV3: modePatch.minWeeklyYield,
    },
  };
}

export function getFinalDisplayRecommendation(item) {
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

export function getLegPremiumValue(leg) {
  const premium = Number(
    leg?.bid ??
      leg?.premiumUsed ??
      leg?.mid ??
      leg?.premium ??
      leg?.primeUsed
  );
  return Number.isFinite(premium) && premium > 0 ? premium : null;
}

export function getLegSpreadPct(leg) {
  return normalizedIbkrSpreadPctPercent(leg?.liquidity?.spreadPct ?? leg?.spreadPct);
}

export function getLegYieldPct(leg, candidate) {
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

export function getLegDistancePct(leg) {
  const distance = Number(leg?.distancePct ?? NaN);
  return Number.isFinite(distance) ? distance : null;
}

export function getLegPopPct(leg) {
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

export function computeTickerQualityOverlay(candidate) {
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


export function isUnknownUnvalidatedTicker(card) {
  const meta = getTickerDisplayMeta(String(card?.ticker ?? "").toUpperCase());
  return meta.qualityTier === "Inconnu à valider";
}
export function buildCapitalComboCandidate(candidate, usableCapital) {
  const ticker = String(candidate?.ticker || "").trim().toUpperCase();
  const meta = getTickerDisplayMeta(ticker);
  const recommendation = getFinalDisplayRecommendation(candidate);
  const finalDisplayMode =
    String(candidate?.finalDisplayMode || "").trim().toUpperCase() || recommendation.finalDisplayMode;
  const finalDisplayGrade =
    String(candidate?.finalDisplayGrade || "").trim().toUpperCase() || recommendation.finalDisplayGrade;

  // ─── Jambes par bucket (indépendantes du mode global) ────────────────────
  const safeLeg = candidate?.safeStrike ?? null;
  const aggLeg = candidate?.aggressiveStrike ?? null;

  const safeStrikeValue = Number(safeLeg?.strike ?? NaN);
  const safePremium = getLegPremiumValue(safeLeg);
  const safeSpreadPct = getLegSpreadPct(safeLeg);
  const safeYieldPct = getLegYieldPct(safeLeg, candidate);
  const safeDistancePct = getLegDistancePct(safeLeg);
  const safePopPct = getLegPopPct(safeLeg);
  const safeCapital = Number.isFinite(safeStrikeValue) && safeStrikeValue > 0 ? safeStrikeValue * 100 : 0;
  const safeGrade = String(candidate?.safeGrade ?? "").toUpperCase() || null;

  const aggStrikeValue = Number(aggLeg?.strike ?? NaN);
  const aggPremium = getLegPremiumValue(aggLeg);
  const aggSpreadPct = getLegSpreadPct(aggLeg);
  const aggYieldPct = getLegYieldPct(aggLeg, candidate);
  const aggDistancePct = getLegDistancePct(aggLeg);
  const aggPopPct = getLegPopPct(aggLeg);
  const aggCapital = Number.isFinite(aggStrikeValue) && aggStrikeValue > 0 ? aggStrikeValue * 100 : 0;
  // Derive grade from actual leg yield (bid/strike fallback) — avoids weeklyYield=0 giving "WATCH"
  const _aggDerivedGrade = gradeLeg({
    spreadPct: aggSpreadPct,
    weeklyYieldPct: aggYieldPct,
    popDecimal: aggLeg?.popProfitEstimated ?? aggLeg?.popEstimate,
  });
  const _aggStoredGrade = String(candidate?.aggressiveGrade ?? "").toUpperCase() || null;
  const aggGrade =
    getAggressivePriorityGrade({
      spreadPct: aggSpreadPct,
      weeklyYieldPct: aggYieldPct,
      popDecimal: aggLeg?.popProfitEstimated ?? aggLeg?.popEstimate,
      distancePct: aggDistancePct,
    }) ??
    (_aggDerivedGrade !== "REJECT" ? _aggDerivedGrade : null) ??
    _aggStoredGrade;

  const hasSafeLegValid = !!safeLeg &&
    Number.isFinite(safeStrikeValue) && safeStrikeValue > 0 &&
    Number.isFinite(safePremium) && safePremium > 0 &&
    Number.isFinite(safeSpreadPct) && safeSpreadPct <= 35 &&
    Number.isFinite(safeYieldPct) && safeYieldPct > 0;

  const hasAggLegValid = !!aggLeg &&
    Number.isFinite(aggStrikeValue) && aggStrikeValue > 0 &&
    Number.isFinite(aggPremium) && aggPremium > 0 &&
    Number.isFinite(aggSpreadPct) && aggSpreadPct <= 35 &&
    Number.isFinite(aggYieldPct) && aggYieldPct > 0;

  const commonBlocked =
    (meta.isCryptoBlocked && !meta.isCryptoAllowed) ||
    meta.qualityTier === "Inconnu à valider";

  // ─── Jambe globale (compat affichage compact principal) ──────────────────
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
    // Données per-bucket (indépendantes du mode global)
    _safeLeg: safeLeg,
    _aggLeg: aggLeg,
    _safeYieldPct: safeYieldPct,
    _aggYieldPct: aggYieldPct,
    _safeSpreadPct: safeSpreadPct,
    _aggSpreadPct: aggSpreadPct,
    _safeStrikeValue: safeStrikeValue,
    _aggStrikeValue: aggStrikeValue,
    _safeCapital: safeCapital,
    _aggCapital: aggCapital,
    _safeDistancePct: safeDistancePct,
    _aggDistancePct: aggDistancePct,
    _safePopPct: safePopPct,
    _aggPopPct: aggPopPct,
    _safeGrade: safeGrade,
    _aggGrade: aggGrade,
    _hasSafeLegValid: hasSafeLegValid && !commonBlocked && !isUnknownTicker,
    _hasAggLegValid: hasAggLegValid && !commonBlocked && !isUnknownTicker,
    _qualityOverlay: computeTickerQualityOverlay({
      ...candidate,
      ticker,
      spreadPct,
      weeklyReturn,
      _popForCombo: popEstimate,
    }),
    _capitalComboExclusionReasons: capitalComboExclusionReasons,
    // Éligibilité large : au moins une jambe bucket valide, pas de blocage global
    _isCapitalComboEligible:
      !commonBlocked &&
      !isUnknownTicker &&
      (hasSafeLegValid || hasAggLegValid),
  };
}

export function buildPortfolioCombos(candidates, capital, maxCapitalPct, maxPositions, rejectedIbkrSymbols = new Set(), options = {}) {
  const usableCapital = capital * (maxCapitalPct / 100);
  const targetMinPct = 90;
  const targetGoalPct = 95;
  const basePool = candidates
    .filter((c) => !rejectedIbkrSymbols.has(String(c?.ticker || "").trim().toUpperCase()))
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
      minWeeklyYield: 0.95,
      maxWeeklyYield: null,
      minExecutionScore: 0.45,
      maxSpreadPct: 25,
      allowedModes: new Set(["AGGRESSIVE"]),
      allowedGrades: new Set(["A", "B"]),
      watchPremiumFilter: (c) => {
        const pop = c._popForCombo;
        const spread = c.selectedSpreadPct;
        const yld = c.selectedYieldPct;
        const dist = c.selectedDistancePct;
        return (
          pop != null && pop >= 85 &&
          (spread == null || spread <= 20) &&
          yld != null && yld >= 0.90 &&
          dist != null && dist <= -6
        );
      },
      maxWatchPremiumContracts: 1,
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
      tickerCapPct: 0.30,
      positionCapPct: 0.30,
      maxContractsPerTicker: 3,
      minTargetPositions: 3,
      maxThemeCapitalPct: 0.45,
      maxSectorCapitalPct: 0.45,
      maxHighBetaCapitalPct: 0.35,
      // BITX est le seul crypto autorisé dans BALANCED — limité à 1 contrat max
      maxBitxContracts: 1,
      minWeeklyYield: 0.70,
      maxWeeklyYield: 1.05,
      minExecutionScore: 0,
      maxSpreadPct: 20,
      allowedModes: new Set(["SAFE", "AGGRESSIVE"]),
      allowedGrades: new Set(["A", "B"]),
      watchPremiumFilter: (c) => {
        const pop = c._popForCombo;
        const spread = c.selectedSpreadPct;
        const yld = c.selectedYieldPct;
        const dist = c.selectedDistancePct;
        return (
          pop != null && pop >= 88 &&
          (spread == null || spread <= 15) &&
          yld != null && yld >= 0.75 && yld <= 1.05 &&
          dist != null && dist <= -6
        );
      },
      maxWatchPremiumContracts: 1,
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
      minWeeklyYield: 0.45,
      maxWeeklyYield: 0.80,
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
    const optimizerV2 = resolveOptimizerV2ForCombo(options?.optimizerV2);
    let modeAlloc = mode;
    let maxPositionLines = maxPositions;
    let balancedInstitutionalV3Audit = null;
    if (mode.id === "balanced") {
      const v3 = computeBalancedInstitutionalV3(mode, usableCapital, maxPositions);
      modeAlloc = { ...mode, ...v3.modePatch };
      maxPositionLines = v3.lineCap;
      balancedInstitutionalV3Audit = v3.audit;
    }
    const rejectionTotals = new Map();
    const scoredPool = basePool
      // Étape 1 : résoudre la jambe spécifique au bucket (simulation indépendante)
      .map((candidate) => {
        let bucketLeg = null;
        let bucketStrikeValue = null;
        let bucketCapital = 0;
        let bucketGrade = null;

        if (mode.id === "conservative") {
          // SAFE : utiliser exclusivement la jambe SAFE
          if (candidate._hasSafeLegValid) {
            bucketLeg = candidate._safeLeg;
            bucketStrikeValue = candidate._safeStrikeValue;
            bucketCapital = candidate._safeCapital;
            bucketGrade = candidate._safeGrade;
          }
        } else if (mode.id === "aggressive") {
          // AGGRESSIVE : utiliser exclusivement la jambe AGGRESSIVE
          if (candidate._hasAggLegValid) {
            bucketLeg = candidate._aggLeg;
            bucketStrikeValue = candidate._aggStrikeValue;
            bucketCapital = candidate._aggCapital;
            bucketGrade = candidate._aggGrade;
          }
        } else {
          // BALANCED : choisir la meilleure jambe dans la bande de rendement [0.75, 1.05)
          // MID = centre de rendement cible (0.875%) — NE PAS confondre avec le prix mid option
          // Le prix utilisé reste exclusivement le BID de l'option, jamais le mid bid/ask
          // La bande [0.75, 1.05) capture toute la plage autorisée par maxWeeklyYield
          const safeY = candidate._safeYieldPct;
          const aggY = candidate._aggYieldPct;
          const safeInRange = candidate._hasSafeLegValid && safeY >= 0.75 && safeY < 1.05;
          const aggInRange = candidate._hasAggLegValid && aggY >= 0.75 && aggY < 1.05;
          const MID = 0.875;
          if (safeInRange && aggInRange) {
            if (Math.abs(safeY - MID) <= Math.abs(aggY - MID)) {
              bucketLeg = candidate._safeLeg; bucketStrikeValue = candidate._safeStrikeValue;
              bucketCapital = candidate._safeCapital; bucketGrade = candidate._safeGrade;
            } else {
              bucketLeg = candidate._aggLeg; bucketStrikeValue = candidate._aggStrikeValue;
              bucketCapital = candidate._aggCapital; bucketGrade = candidate._aggGrade;
            }
          } else if (safeInRange) {
            bucketLeg = candidate._safeLeg; bucketStrikeValue = candidate._safeStrikeValue;
            bucketCapital = candidate._safeCapital; bucketGrade = candidate._safeGrade;
          } else if (aggInRange) {
            bucketLeg = candidate._aggLeg; bucketStrikeValue = candidate._aggStrikeValue;
            bucketCapital = candidate._aggCapital; bucketGrade = candidate._aggGrade;
          } else if (candidate._hasAggLegValid) {
            bucketLeg = candidate._aggLeg; bucketStrikeValue = candidate._aggStrikeValue;
            bucketCapital = candidate._aggCapital; bucketGrade = candidate._aggGrade;
          } else if (candidate._hasSafeLegValid) {
            bucketLeg = candidate._safeLeg; bucketStrikeValue = candidate._safeStrikeValue;
            bucketCapital = candidate._safeCapital; bucketGrade = candidate._safeGrade;
          }
        }

        if (!bucketLeg) return { ...candidate, _hasBucketLeg: false };

        const bucketPremium = getLegPremiumValue(bucketLeg);
        const bucketSpread = getLegSpreadPct(bucketLeg);
        const bucketYield = getLegYieldPct(bucketLeg, candidate);
        const bucketDistance = getLegDistancePct(bucketLeg);
        const bucketPop = getLegPopPct(bucketLeg);
        const resolvedCapital = Number.isFinite(bucketStrikeValue) && bucketStrikeValue > 0
          ? bucketStrikeValue * 100
          : bucketCapital;
        const resolvedGrade = String(bucketGrade ?? candidate.finalDisplayGrade ?? "").toUpperCase();

        return {
          ...candidate,
          _hasBucketLeg: true,
          selectedLeg: bucketLeg,
          selectedStrikeValue: bucketStrikeValue,
          selectedPremiumUnit: bucketPremium,
          selectedSpreadPct: bucketSpread,
          selectedYieldPct: bucketYield,
          selectedDistancePct: bucketDistance,
          _popForCombo: bucketPop,
          capitalPerContract: resolvedCapital,
          premiumPerContract: Number.isFinite(bucketPremium) && bucketPremium > 0 ? bucketPremium * 100 : 0,
          finalDisplayGrade: resolvedGrade || candidate.finalDisplayGrade,
          weeklyReturn: bucketYield ?? candidate.weeklyReturn,
          spreadPct: bucketSpread ?? candidate.spreadPct,
          // Recompute quality overlay with bucket-specific leg metrics so that
          // filterCandidate sees the correct spread/yield/pop for this specific leg
          _qualityOverlay: computeTickerQualityOverlay({
            ...candidate,
            spreadPct: bucketSpread,
            weeklyReturn: bucketYield,
            _popForCombo: bucketPop,
          }),
        };
      })
      // Étape 2 : exclure les candidats sans jambe bucket
      .filter((candidate) => candidate._hasBucketLeg)
      // Étape 3 : scorer avec la jambe bucket (les valeurs sélectées ont été remplacées)
      .map((candidate) => ({
        ...candidate,
        selectedStrike: getModeStrike(candidate, mode.id),
        _comboScoreBreakdown: buildCapitalComboScoreBreakdown(candidate, modeAlloc, usableCapital, poolStats),
      }))
      // Étape 4 : filtres bucket (appliqués après résolution jambe)
      .filter((candidate) => candidate.capitalPerContract > 0 && candidate.capitalPerContract <= usableCapital && candidate.weeklyReturn > 0)
      // allowedModes retiré — remplacé par la résolution bucket ci-dessus
      .filter((candidate) => {
        if (modeAlloc.allowedGrades?.has(candidate.finalDisplayGrade)) return true;
        if (candidate.finalDisplayGrade === "WATCH" && modeAlloc.watchPremiumFilter?.(candidate)) return true;
        return false;
      })
      .map((candidate) => ({
        ...candidate,
        _isWatchPremium: candidate.finalDisplayGrade === "WATCH" && !!modeAlloc.watchPremiumFilter?.(candidate),
      }))
      .filter((candidate) => candidate.weeklyReturn >= modeAlloc.minWeeklyYield)
      .filter((candidate) => modeAlloc.maxWeeklyYield == null || candidate.weeklyReturn < modeAlloc.maxWeeklyYield)
      .filter((candidate) => !Number.isFinite(candidate.proExecutionScore) || candidate.proExecutionScore >= modeAlloc.minExecutionScore)
      .filter((candidate) => candidate.spreadPct == null || candidate.spreadPct <= modeAlloc.maxSpreadPct)
      .filter((candidate) =>
        modeAlloc.minDistancePct == null ||
        candidate.selectedDistancePct == null ||
        candidate.selectedDistancePct <= modeAlloc.minDistancePct
      )
      .filter((candidate) => modeAlloc.filterCandidate ? modeAlloc.filterCandidate(candidate) : true)
      .map((candidate) => ({
        ...candidate,
        allocScore: (candidate._comboScoreBreakdown?.totalScore ?? modeAlloc.score(candidate)) - (candidate._isWatchPremium ? 15 : 0),
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
    const tickerCapDollars = usableCapital * modeAlloc.tickerCapPct;
    const positionCapDollars = usableCapital * modeAlloc.positionCapPct;
    const NEUTRAL_CLUSTER_KEYS = new Set(["unknown", "none", "no_theme", "other", ""]);
    const feasibleDistinctTickers = new Set(scoredPool.map((candidate) => candidate.ticker)).size;
    const minTargetPositions = Math.max(
      1,
      Math.min(Number(maxPositionLines) || 0, Number(modeAlloc.minTargetPositions ?? 3), feasibleDistinctTickers)
    );
    let lastRejectionCounts = new Map();

    /** Phase 2A — instrumentation lecture seule (export Inspector / allocationTraceV1). */
    const diagnosticsEnabledForTrace = optimizerV2.capDiagnosticsEnabled !== false;
    const traceAccum = diagnosticsEnabledForTrace
      ? { cycleRows: [], selectedRows: [], rejectionRows: [], leftoverRejectSamples: [] }
      : null;
    const CYCLE_ROWS_CAP = 5200;
    const REJECTION_ROWS_CAP = 900;
    const LEFTOVER_REJECT_CAP = 120;
    let allocationCycleOrdinal = 0;

    /** Classe rang post-tri allocatedScore principal (doublons tickers très rares : dernier rang gagne). */
    const candidateRankByTicker = scoredPool.reduce((acc, cand, idx) => {
      acc[String(cand.ticker || "").trim().toUpperCase()] = idx + 1;
      return acc;
    }, {});
    /** Position du ticker dans scoredPool après tri allocation (pour l’ordre exact testé ligne par ligne). */
    const candidateSweepIndexByTicker = scoredPool.reduce((acc, cand, idx) => {
      acc[String(cand.ticker || "").trim().toUpperCase()] = idx;
      return acc;
    }, {});

    function traceFlagsFromRejectReason(ok, reason) {
      if (ok) {
        return {
          passedCapitalCheck: true,
          passedTickerCap: true,
          passedSectorCap: true,
          passedThemeCap: true,
          passedHighBetaCap: true,
          blockerType: null,
        };
      }
      const r = reason ?? "caps_too_strict";
      return {
        passedCapitalCheck: r !== "contract_size_too_large",
        passedTickerCap: r !== "ticker_cap_reached",
        passedSectorCap: r !== "sector_cap_reached",
        passedThemeCap: r !== "theme_cap_reached",
        passedHighBetaCap: r !== "high_beta_cap_reached",
        blockerType: r,
      };
    }

    function pushCycleRow(payload) {
      if (!traceAccum || traceAccum.cycleRows.length >= CYCLE_ROWS_CAP) return;
      traceAccum.cycleRows.push(payload);
    }

    function pushRejectionRow(payload) {
      if (!traceAccum || traceAccum.rejectionRows.length >= REJECTION_ROWS_CAP) return;
      traceAccum.rejectionRows.push(payload);
    }

    function pushLeftoverRejectSample(sample) {
      if (!traceAccum || traceAccum.leftoverRejectSamples.length >= LEFTOVER_REJECT_CAP) return;
      traceAccum.leftoverRejectSamples.push(sample);
    }

    function flushSweepTrace(
      rows,
      phaseLabel,
      cycleNum,
      sweepFreeCapitalSnapshot,
      sweepPositionsSnapshot,
      freeCapitalHint = null,
    ) {
      if (!traceAccum || rows.length === 0) return;
      const capitalBeforeSweep = sweepFreeCapitalSnapshot;
      const positionsBeforeSweep = sweepPositionsSnapshot;
      const freeHint =
        freeCapitalHint != null && Number.isFinite(freeCapitalHint)
          ? freeCapitalHint
          : null;
      for (const row of rows) {
        const cand = row.candidate;
        const tickerKey = String(cand.ticker ?? "");
        const tk = tickerKey.trim().toUpperCase();
        let decision = "rejected";
        let reasonStr = row.failReason ?? "caps_too_strict";
        let capitalAfterIfSel = null;
        if (!row.failReason && row.okEvaluated?.ok) {
          const wins = !!(row.winningSweep && row.candidate?.ticker === row.bestTicker);
          if (wins) {
            decision = "selected";
            reasonStr =
              row.usedSoftCaps && phaseLabel === "filler_primary"
                ? "selected_filler_with_soft_caps"
                : phaseLabel.includes("soft")
                  ? "selected_primary_with_soft_contract_caps"
                  : row.selectionHint ?? `selected_${phaseLabel}`;
            const req = Number(cand.capitalPerContract);
            capitalAfterIfSel = usableCapital - used - req;
          } else {
            decision = "skipped";
            reasonStr =
              phaseLabel.startsWith("leftover")
                ? "not_selected_leftover_density_greedy_score"
                : phaseLabel.includes("filler")
                  ? "not_selected_filler_greedy_score"
                  : "not_selected_primary_greedy_marginalScore";
            const req = Number(cand.capitalPerContract);
            capitalAfterIfSel = usableCapital - used - req;
          }
        }

        pushCycleRow({
          cycle: cycleNum,
          allocationPhase: phaseLabel,
          capitalBefore: capitalBeforeSweep,
          positionsBefore: positionsBeforeSweep,
          freeCapitalAtSweepStart: freeHint ?? capitalBeforeSweep,
          candidateTicker: tickerKey,
          candidateMode: cand.finalDisplayMode ?? cand.mode ?? null,
          candidateCapitalRequired:
            cand.capitalPerContract ?? null,
          candidateYieldPct:
            cand.weeklyReturn ?? cand.selectedYieldPct ?? null,
          candidateScore:
            cand._comboScoreBreakdown?.totalScore ?? cand.allocScore ?? null,
          candidateRank: candidateRankByTicker[tk] ?? null,
          candidateGrade: cand.finalDisplayGrade ?? cand.grade ?? null,
          candidateSpreadPct: cand.selectedSpreadPct ?? cand.spreadPct ?? null,
          candidatePop: cand._popForCombo ?? null,
          decision,
          reason: reasonStr,
          capitalAfterIfSelected:
            typeof capitalAfterIfSel === "number" && Number.isFinite(capitalAfterIfSel)
              ? capitalAfterIfSel
              : null,
          usedSoftCapsInEval: !!row.usedSoftCaps,
          sweepOrdinalInBucket: candidateSweepIndexByTicker[tk] ?? null,
        });

        if (decision === "rejected" && row.failReason) {
          const flags = traceFlagsFromRejectReason(false, row.failReason);
          pushRejectionRow({
            ticker: tickerKey,
            mode: cand.finalDisplayMode ?? cand.mode ?? null,
            capitalRequired: cand.capitalPerContract ?? null,
            capitalRemainingAtDecision: usableCapital - used,
            reasonRejected: row.failReason ?? "caps_too_strict",
            blockerType: row.failReason ?? "caps_too_strict",
            passedBucketFilters: true,
            passedCapitalCheck: flags.passedCapitalCheck,
            passedTickerCap: flags.passedTickerCap,
            passedSectorCap: flags.passedSectorCap,
            passedThemeCap: flags.passedThemeCap,
            passedHighBetaCap: flags.passedHighBetaCap,
            allocationPhase: phaseLabel,
            cycle: cycleNum,
          });
        }
      }
    }

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
      const maxCrypto = modeAlloc.maxCryptoMinerPositions;
      const maxSpec = modeAlloc.maxSpeculativePositions;
      if (maxCrypto == null && maxSpec == null) return { ok: true };
      const ov = candidate._qualityOverlay;
      const theme = ov?.concentrationTheme ?? null;
      const tier = ov?.qualityTier ?? null;
      if (maxCrypto != null && theme === "crypto_miner") {
        const currentCrypto = state.cryptoMinerPositions;
        const hardMax = modeAlloc.maxCryptoMinerExceptionCount ?? maxCrypto;
        if (currentCrypto >= hardMax) return { ok: false, reason: "theme_cap_reached" };
        if (currentCrypto >= maxCrypto) {
          const pop = candidate._popForCombo;
          const spread = candidate.spreadPct;
          const quality = ov?.qualityScore ?? 0;
          const ok =
            pop != null && pop >= (modeAlloc.maxCryptoMinerExceptionPopMin ?? 82) &&
            (spread == null || spread <= (modeAlloc.maxCryptoMinerExceptionSpreadMax ?? 20)) &&
            quality >= (modeAlloc.maxCryptoMinerExceptionQualityMin ?? 0.65);
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
        if (state.distinctPositions >= maxPositionLines) return false;
        if (candidate.capitalPerContract > tickerCapDollars) return false;
        if (candidate.capitalPerContract > positionCapDollars) return false;
        if (!canAddByComposition(candidate, state).ok) return false;
        // Enforce cluster caps when near/at target positions (mirrors evaluateCandidate without recursion)
        const nextDistinctPositions = state.distinctPositions + 1;
        if (nextDistinctPositions >= minTargetPositions) {
          const themeKey = String(candidate?._qualityOverlay?.concentrationTheme || "").trim().toLowerCase();
          const sectorKey = String(candidate?._tickerMeta?.sector || "").trim().toLowerCase();
          if (themeKey && !NEUTRAL_CLUSTER_KEYS.has(themeKey)) {
            const nextThemeCapital = (state.themeCapitalMap.get(themeKey) ?? 0) + candidate.capitalPerContract;
            if (nextThemeCapital > usableCapital * (modeAlloc.maxThemeCapitalPct ?? 0.45)) return false;
          }
          if (sectorKey && !NEUTRAL_CLUSTER_KEYS.has(sectorKey)) {
            const nextSectorCapital = (state.sectorCapitalMap.get(sectorKey) ?? 0) + candidate.capitalPerContract;
            if (nextSectorCapital > usableCapital * (modeAlloc.maxSectorCapitalPct ?? 0.45)) return false;
          }
          const nextHighBetaCapital =
            state.highBetaCapital + (candidate?._qualityOverlay?.concentrationTheme === "high_beta_growth" ? candidate.capitalPerContract : 0);
          if (nextHighBetaCapital > usableCapital * (modeAlloc.maxHighBetaCapitalPct ?? 0.40)) return false;
        }
        return true;
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
      const tickerCapSoftPct = (Number(modeAlloc.tickerCapPct) || 0.3) * 100;
      const themeCapSoftPct = (Number(modeAlloc.maxThemeCapitalPct) || 0.45) * 100;
      const sectorCapSoftPct = (Number(modeAlloc.maxSectorCapitalPct) || 0.45) * 100;
      const highBetaCapSoftPct = (Number(modeAlloc.maxHighBetaCapitalPct) || 0.4) * 100;
      let penalty = 0;
      penalty += Math.max(0, largestTickerPct - tickerCapSoftPct) * 0.9;
      penalty += Math.max(0, largestThemePct - themeCapSoftPct) * 0.55;
      penalty += Math.max(0, largestSectorPct - sectorCapSoftPct) * 0.45;
      penalty += Math.max(0, nextHighBetaPct - highBetaCapSoftPct) * 0.6;
      if (isExisting) penalty += 6;
      return { penalty };
    }

    function evaluateCandidate(candidate, useSoftCaps = false) {
      const existing = pickMap.get(candidate.ticker);
      const isExisting = !!existing;
      const currentContracts = existing?.contracts ?? 0;
      const state = computePortfolioState();
      const nextUsed = used + candidate.capitalPerContract;
      const maxContractsAllowed = useSoftCaps ? modeAlloc.maxContractsPerTicker + 1 : modeAlloc.maxContractsPerTicker;
      const nextPositionCapital = (currentContracts + 1) * candidate.capitalPerContract;
      const tickerCapLimit = useSoftCaps ? tickerCapDollars * 1.1 : tickerCapDollars;
      const positionCapLimit = useSoftCaps ? positionCapDollars * 1.1 : positionCapDollars;
      const nextDistinctPositions = isExisting ? state.distinctPositions : state.distinctPositions + 1;

      if (candidate.capitalPerContract <= 0) return { ok: false, reason: "contract_size_too_large" };
      if (currentContracts >= maxContractsAllowed) return { ok: false, reason: "ticker_cap_reached" };
      // Limite spécifique par ticker selon config mode (ex: BITX max 1 contrat dans BALANCED)
      if (modeAlloc.maxBitxContracts != null && String(candidate.ticker).toUpperCase() === "BITX" && currentContracts >= modeAlloc.maxBitxContracts) {
        return { ok: false, reason: "ticker_cap_reached" };
      }
      // WATCH premium : max 1 contrat par ticker — score pénalisé, jamais renforcé
      if (candidate._isWatchPremium && currentContracts >= (modeAlloc.maxWatchPremiumContracts ?? 1)) {
        return { ok: false, reason: "ticker_cap_reached" };
      }
      if (!isExisting && state.distinctPositions >= maxPositionLines) return { ok: false, reason: "max_positions_limit" };
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
        if (nextTickerCapital > usableCapital * modeAlloc.tickerCapPct) {
          return { ok: false, reason: "ticker_cap_reached" };
        }
        if (
          themeKey &&
          !NEUTRAL_CLUSTER_KEYS.has(themeKey) &&
          nextThemeCapital > usableCapital * (modeAlloc.maxThemeCapitalPct ?? 0.45)
        ) {
          return { ok: false, reason: "theme_cap_reached" };
        }
        if (
          sectorKey &&
          !NEUTRAL_CLUSTER_KEYS.has(sectorKey) &&
          nextSectorCapital > usableCapital * (modeAlloc.maxSectorCapitalPct ?? 0.45)
        ) {
          return { ok: false, reason: "sector_cap_reached" };
        }
        if (
          nextHighBetaCapital > usableCapital * (modeAlloc.maxHighBetaCapitalPct ?? 0.40)
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
      const sweepFreeCapitalSnapshot = usableCapital - used;
      const sweepPositionsSnapshot = picks.length;
      const cycleNumTrace = diagnosticsEnabledForTrace ? ++allocationCycleOrdinal : 0;
      const phaseLabel = useSoftCaps ? "primary_soft_cap" : "primary_strict";

      const rejections = new Map();
      let best = null;
      const sweepRows = [];
      for (const candidate of scoredPool) {
        const evaluated = evaluateCandidate(candidate, useSoftCaps);
        if (!evaluated.ok) {
          const key = evaluated.reason ?? "caps_too_strict";
          rejections.set(key, (rejections.get(key) ?? 0) + 1);
          sweepRows.push({ candidate, failReason: key, okEvaluated: evaluated, usedSoftCaps: !!useSoftCaps });
          continue;
        }
        sweepRows.push({
          candidate,
          failReason: null,
          okEvaluated: evaluated,
          usedSoftCaps: !!useSoftCaps,
          selectionHint: evaluated.selectionReason,
        });
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
      const bestTicker = best?.candidate?.ticker ?? null;
      if (traceAccum && cycleNumTrace > 0) {
        for (const sr of sweepRows) {
          sr.bestTicker = bestTicker;
          sr.winningSweep =
            !!(sr.failReason == null && sr.okEvaluated?.ok && sr.candidate?.ticker === bestTicker);
        }
        flushSweepTrace(
          sweepRows,
          phaseLabel,
          cycleNumTrace,
          sweepFreeCapitalSnapshot,
          sweepPositionsSnapshot,
          null,
        );
      }

      lastRejectionCounts = rejections;
      return best;
    }

    function createPick(candidate, selectionReason, comboAllocationPhase = "primary_strict") {
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
        comboAllocationPhase,
      };
    }

    function applySelection(selection, comboAllocationPhase = "primary_strict") {
      const capitalFreeBeforePick = usableCapital - used;
      const { candidate, existing, isExisting, selectionReason } = selection;
      if (!isExisting) {
        const pick = createPick(candidate, selectionReason, comboAllocationPhase);
        picks.push(pick);
        pickMap.set(candidate.ticker, pick);
      } else {
        existing.comboAllocationPhase = comboAllocationPhase;
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

      if (traceAccum) {
        const capitalFreeAfterPick = usableCapital - used;
        traceAccum.selectedRows.push({
          ticker: candidate.ticker,
          mode: candidate.finalDisplayMode ?? null,
          capitalRequired: candidate.capitalPerContract,
          yieldPct:
            candidate.weeklyReturn ??
            candidate.selectedYieldPct ??
            null,
          selectionScore:
            candidate._comboScoreBreakdown?.totalScore ?? candidate.allocScore ?? null,
          capitalBefore: capitalFreeBeforePick,
          capitalAfter: capitalFreeAfterPick,
          comboAllocationPhase,
          reasonSelected:
            typeof selectionReason === "string"
              ? selectionReason
              : "unknown",
        });
      }
    }

    function pickBestFillerCandidate() {
      const sweepFreeCapitalSnapshot = usableCapital - used;
      const sweepPositionsSnapshot = picks.length;
      const cycleNumTrace = diagnosticsEnabledForTrace ? ++allocationCycleOrdinal : 0;

      const freeCapital = usableCapital - used;
      if (freeCapital <= 0) return null;

      const rejections = new Map();
      let best = null;

      const sweepRows = [];

      for (const candidate of scoredPool) {
        if (candidate.capitalPerContract <= 0 || candidate.capitalPerContract > freeCapital) {
          rejections.set("contract_size_too_large", (rejections.get("contract_size_too_large") ?? 0) + 1);
          sweepRows.push({ candidate, failReason: "contract_size_too_large", okEvaluated: null, usedSoftCaps: false });
          continue;
        }

        let evaluated = evaluateCandidate(candidate, false);
        let usedSoftCaps = false;
        if (!evaluated.ok) {
          const strictReason = evaluated.reason ?? "caps_too_strict";
          const softEvaluated = evaluateCandidate(candidate, true);
          if (!softEvaluated.ok) {
            const key = softEvaluated.reason ?? strictReason;
            rejections.set(key, (rejections.get(key) ?? 0) + 1);
            sweepRows.push({
              candidate,
              failReason: key,
              okEvaluated: softEvaluated,
              usedSoftCaps: false,
            });
            continue;
          }
          evaluated = softEvaluated;
          usedSoftCaps = true;
        }

        const freeAfter = freeCapital - candidate.capitalPerContract;
        const deployEfficiency = 1 - (freeAfter / Math.max(1, freeCapital));
        const smallContractBonus = 1 - Math.min(1, candidate.capitalPerContract / Math.max(1, usableCapital));
        const premiumEfficiency = Math.max(0, candidate.weeklyReturn ?? 0);
        const diversificationBonus = evaluated.isExisting ? 0 : 1.8;
        const watchPenalty = candidate._isWatchPremium ? 1.2 : 0;
        const speculativePenalty = candidate._qualityOverlay?.qualityTier === "speculative" ? 1.4 : 0;
        const fillerScore =
          Number(evaluated.marginalScore ?? 0) +
          deployEfficiency * 16 +
          premiumEfficiency * 9 +
          smallContractBonus * 4 +
          diversificationBonus -
          watchPenalty -
          speculativePenalty;

        const selectionReasonParts = [evaluated.selectionReason ?? "selected: filler pass"];
        selectionReasonParts.push("filler: capital libre deploye sans relacher les garde-fous");
        if (!evaluated.isExisting) {
          selectionReasonParts.push("filler: nouvelle ligne privilegiee");
        } else {
          selectionReasonParts.push("filler: renfort sous caps");
        }
        if (usedSoftCaps) {
          selectionReasonParts.push("filler: soft caps existants utilises");
        }

        const enriched = {
          ...evaluated,
          marginalScore: fillerScore,
          selectionReason: selectionReasonParts.join(" · "),
          _fillerFreeAfter: freeAfter,
        };

        if (
          !best ||
          enriched.marginalScore > best.marginalScore ||
          (
            enriched.marginalScore === best.marginalScore &&
            enriched._fillerFreeAfter < best._fillerFreeAfter
          ) ||
          (
            enriched.marginalScore === best.marginalScore &&
            enriched._fillerFreeAfter === best._fillerFreeAfter &&
            !enriched.isExisting &&
            !!best.isExisting
          ) ||
          (
            enriched.marginalScore === best.marginalScore &&
            enriched._fillerFreeAfter === best._fillerFreeAfter &&
            ((enriched.candidate.weeklyReturn ?? 0) > (best.candidate.weeklyReturn ?? 0))
          )
        ) {
          best = enriched;
        }

        sweepRows.push({
          candidate,
          failReason: null,
          okEvaluated: evaluated,
          usedSoftCaps,
          selectionHint: selectionReasonParts.join(" · "),
        });
      }

      const bestTicker = best?.candidate?.ticker ?? null;
      if (traceAccum && cycleNumTrace > 0) {
        for (const sr of sweepRows) {
          sr.bestTicker = bestTicker;
          sr.winningSweep =
            !!(sr.failReason == null && sr.okEvaluated?.ok && sr.candidate?.ticker === bestTicker);
        }
        flushSweepTrace(
          sweepRows,
          "filler_primary",
          cycleNumTrace,
          sweepFreeCapitalSnapshot,
          sweepPositionsSnapshot,
          freeCapital,
        );
      }

      lastRejectionCounts = rejections;
      return best;
    }

    function pickBestDensityLeftoverCandidate() {
      const sweepFreeCapitalSnapshot = usableCapital - used;
      const sweepPositionsSnapshot = picks.length;
      const cycleNumTrace = diagnosticsEnabledForTrace ? ++allocationCycleOrdinal : 0;

      const freeCapital = usableCapital - used;
      if (freeCapital <= 0) return null;

      const rejections = new Map();
      let best = null;
      const ordered = [...scoredPool].sort(compareLeftoverDensityOrder);

      const sweepRows = [];

      for (const candidate of ordered) {
        if (candidate.capitalPerContract <= 0 || candidate.capitalPerContract > freeCapital) {
          rejections.set("contract_size_too_large", (rejections.get("contract_size_too_large") ?? 0) + 1);
          sweepRows.push({ candidate, failReason: "contract_size_too_large", okEvaluated: null, usedSoftCaps: false });
          pushLeftoverRejectSample({
            ticker: candidate.ticker,
            capitalRequired: candidate.capitalPerContract ?? null,
            reasonRejected: "contract_size_too_large",
          });
          continue;
        }

        let evaluated = evaluateCandidate(candidate, false);
        let usedSoftCaps = false;
        if (!evaluated.ok) {
          const strictReason = evaluated.reason ?? "caps_too_strict";
          const softEvaluated = evaluateCandidate(candidate, true);
          if (!softEvaluated.ok) {
            const key = softEvaluated.reason ?? strictReason;
            rejections.set(key, (rejections.get(key) ?? 0) + 1);
            sweepRows.push({
              candidate,
              failReason: key,
              okEvaluated: softEvaluated,
              usedSoftCaps: false,
            });
            pushLeftoverRejectSample({
              ticker: candidate.ticker,
              capitalRequired: candidate.capitalPerContract ?? null,
              reasonRejected: key,
            });
            continue;
          }
          evaluated = softEvaluated;
          usedSoftCaps = true;
        }

        const dens = premiumDensityScore(candidate);
        const freeAfter = freeCapital - candidate.capitalPerContract;
        const deployEfficiency = 1 - (freeAfter / Math.max(1, freeCapital));
        const smallContractBonus =
          dens * 110 +
          // favor smaller collateral when densities tie — deploy dead capital aggressively
          (1 - Math.min(1, candidate.capitalPerContract / Math.max(1, usableCapital))) * 42;
        const premiumEfficiency = Math.max(0, candidate.weeklyReturn ?? 0);
        const diversificationBonus = evaluated.isExisting ? 0 : 4.2;
        const watchPenalty = candidate._isWatchPremium ? 1.4 : 0;
        const speculativePenalty = candidate._qualityOverlay?.qualityTier === "speculative" ? 1.65 : 0;
        const densityScoreComposite =
          Number(evaluated.marginalScore ?? 0) +
          deployEfficiency * 18 +
          premiumEfficiency * 8 +
          smallContractBonus +
          diversificationBonus -
          watchPenalty -
          speculativePenalty;

        const selectionReasonParts = [
          evaluated.selectionReason ?? "selected: leftover density V2",
          "leftoverV2: priorise prime/collateral + petites garanties lorsque capital libre encore utile",
        ];
        if (!evaluated.isExisting) {
          selectionReasonParts.push("leftoverV2: nouvelle ligne pour réduire capital mort");
        } else {
          selectionReasonParts.push("leftoverV2: renfort contrôlé après passe filler standard");
        }
        if (usedSoftCaps) {
          selectionReasonParts.push("leftoverV2: soft caps calqués passe filler existante");
        }

        const enriched = {
          ...evaluated,
          marginalScore: densityScoreComposite,
          selectionReason: selectionReasonParts.join(" · "),
          _fillerFreeAfter: freeAfter,
        };

        if (
          !best ||
          enriched.marginalScore > best.marginalScore ||
          (
            enriched.marginalScore === best.marginalScore &&
            enriched._fillerFreeAfter < best._fillerFreeAfter
          ) ||
          (
            enriched.marginalScore === best.marginalScore &&
            enriched._fillerFreeAfter === best._fillerFreeAfter &&
            !enriched.isExisting &&
            !!best.isExisting
          )
        ) {
          best = enriched;
        }

        sweepRows.push({
          candidate,
          failReason: null,
          okEvaluated: evaluated,
          usedSoftCaps,
          selectionHint: selectionReasonParts.join(" · "),
        });
      }

      const bestTicker = best?.candidate?.ticker ?? null;
      if (traceAccum && cycleNumTrace > 0) {
        for (const sr of sweepRows) {
          sr.bestTicker = bestTicker;
          sr.winningSweep =
            !!(sr.failReason == null && sr.okEvaluated?.ok && sr.candidate?.ticker === bestTicker);
        }
        flushSweepTrace(
          sweepRows,
          "leftover_density_v2",
          cycleNumTrace,
          sweepFreeCapitalSnapshot,
          sweepPositionsSnapshot,
          freeCapital,
        );
      }

      lastRejectionCounts = rejections;
      return best;
    }

    while (true) {
      const best = pickBestCandidate(false);
      mergeRejectionDiagnostics(rejectionTotals, lastRejectionCounts);
      if (best) {
        applySelection(best, "primary_strict");
        continue;
      }
      const currentPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
      if (currentPct >= targetGoalPct) break;
      const softBest = pickBestCandidate(true);
      mergeRejectionDiagnostics(rejectionTotals, lastRejectionCounts);
      if (!softBest) break;
      applySelection(softBest, "primary_soft_cap");
    }

    // Keep SAFE behavior stable: filler pass targets only BALANCED and AGGRESSIVE.
    if (mode.id !== "conservative") {
      while (true) {
        const fillerBest = pickBestFillerCandidate();
        mergeRejectionDiagnostics(rejectionTotals, lastRejectionCounts);
        if (!fillerBest) break;
        applySelection(fillerBest, "filler_primary");
      }
    }

    // Phase 2 V2 — leftover optimisation densité après filler (SAFE désactivée par défaut).
    let leftoverV2Adds = 0;
    let leftoverV2PremiumDelta = 0;
    const leftoverDensityGlobalEnabledFlag = optimizerV2.leftoverDensityPassEnabled !== false;
    let leftoverDensityPassBreakReasonTrace = null;
    let leftoverDensityCrumbUsdTrace = null;
    let leftoverDensityMinContractUsdTrace = null;
    let leftoverDensityLoopEnteredTrace = false;
    let leftoverDensityIterationsRanTrace = 0;

    const leftoverV2EligibleMode =
      picks.length > 0 &&
      ((mode.id !== "conservative" && leftoverDensityGlobalEnabledFlag)
        || (mode.id === "conservative" && optimizerV2.safeLeftoverDensityPassEnabled === true));

    /** SAFE : passe leftover indépendante du flag global leftoverDensityPass (voir safeLeftoverDensityPassEnabled). */
    const conservativeLeftoverIsPolicyOff =
      picks.length > 0 &&
      mode.id === "conservative" &&
      optimizerV2.safeLeftoverDensityPassEnabled !== true;

    const premiumBeforeDensityPass = picks.reduce((s, p) => s + Number(p.premiumCollected || 0), 0);

    const leftoverRemainMeaningful = (usableUsd, usedUsd, thresholdUsd, absUsd) =>
      usableUsd - usedUsd >= Math.max(thresholdUsd * 0.55, absUsd * 0.38);

    if (leftoverV2EligibleMode) {
      const finiteCaps = scoredPool
        .map((c) => Number(c.capitalPerContract))
        .filter((n) => Number.isFinite(n) && n > 0);
      const minContractEligible =
        finiteCaps.length ? Math.min(...finiteCaps) : Number.POSITIVE_INFINITY;
      leftoverDensityMinContractUsdTrace = Number.isFinite(minContractEligible) ? minContractEligible : null;

      const crumbThreshold = computeLeftoverActionThresholdUsd(usableCapital, minContractEligible, optimizerV2);
      leftoverDensityCrumbUsdTrace = crumbThreshold;
      const floorAbsUsd = optimizerV2.leftoverMinAbsoluteUsd ?? 320;

      let it = 0;
      const maxIterations = Number(optimizerV2.maxLeftoverIterations ?? 22);
      leftoverDensityLoopEnteredTrace = false;
      while (it < maxIterations) {
        leftoverDensityLoopEnteredTrace = true;
        const remainingUsd = usableCapital - used;
        if (remainingUsd < crumbThreshold) {
          leftoverDensityPassBreakReasonTrace = "remaining_free_usd_below_crumbThreshold_computeLeftoverActionThresholdUsd";
          break;
        }
        if (!leftoverRemainMeaningful(usableCapital, used, crumbThreshold, floorAbsUsd)) {
          leftoverDensityPassBreakReasonTrace = "remaining_free_usd_below_leftoverRemainMeaningful_floor_relative_to_threshold";
          break;
        }

        leftoverDensityIterationsRanTrace += 1;
        const densityPick = pickBestDensityLeftoverCandidate();
        mergeRejectionDiagnostics(rejectionTotals, lastRejectionCounts);
        if (!densityPick) {
          leftoverDensityPassBreakReasonTrace = "density_sweep_returned_null_all_candidates_failed_eval";
          break;
        }
        applySelection(densityPick, "leftover_density_v2");
        leftoverV2Adds += 1;
        it += 1;
      }

      const premiumAfterDensityPass = picks.reduce((s, p) => s + Number(p.premiumCollected || 0), 0);
      leftoverV2PremiumDelta = premiumAfterDensityPass - premiumBeforeDensityPass;
    }

    /** Détail textualisé lorsque leftoverDensityPass.adds === 0 (Phase 2A audit). */
    function finalizeLeftoverReasonNoAdds() {
      if (leftoverV2Adds !== 0) {
        return "n/a_leftover_pass_did_increment_positions_use_adds_field";
      }
      if (!leftoverV2EligibleMode) {
        if (picks.length === 0) {
          return "gate_off_zero_portfolio_lines_after_primary_allocation_block_runs_entire_density_pass_skipped";
        }
        if (mode.id === "conservative") {
          return optimizerV2.safeLeftoverDensityPassEnabled !== true
            ? "SAFE_requires_safeLeftoverDensityPassEnabled_true_default_false_wheelCapitalComboOptimizerV2Flags"
            : "SAFE_leftover_ineligible_unknown_residual_flag_conflict";
        }
        return leftoverDensityGlobalEnabledFlag === false
          ? "global_leftoverDensityPass_explicitly_disabled_leftoverDensityPassEnabled_false"
          : "leftover_density_gate_off_unknown_residual";
      }
      if (!leftoverDensityLoopEnteredTrace) {
        return "eligible_flags_true_but_outer_while_marker_false_residual_internal_state_inconsistency";
      }
      return (
        leftoverDensityPassBreakReasonTrace ??
        `adds_remain_zero_after_${leftoverDensityIterationsRanTrace}_recorded_density_iteration_attempt_sweeps`
      );
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
      } else if (picks.length >= maxPositionLines) {
        capitalShortfallReason = "max_positions_limit";
      } else if (usableCapital - used < minContractCost) {
        capitalShortfallReason = "contract_size_too_large";
      } else if ((rejectionTotals.get("ticker_cap_reached") ?? 0) > 0) {
        capitalShortfallReason = "ticker_cap_reached";
      } else if ((rejectionTotals.get("theme_cap_reached") ?? 0) > 0) {
        capitalShortfallReason = "theme_cap_reached";
      } else if ((rejectionTotals.get("sector_cap_reached") ?? 0) > 0) {
        capitalShortfallReason = "sector_cap_reached";
      } else if ((rejectionTotals.get("high_beta_cap_reached") ?? 0) > 0) {
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

    const totalPremiumCollected = picks.reduce((s, p) => s + Number(p.premiumCollected || 0), 0);

    const premiumClusterLeakKeys = new Set([
      "ticker_cap_reached",
      "theme_cap_reached",
      "sector_cap_reached",
      "high_beta_cap_reached",
    ]);

    let capDiagnosticsV2 = null;
    if (optimizerV2.capDiagnosticsEnabled !== false) {
      const residualDiagnosticRows = buildNextBestResidualRows(
        scoredPool,
        pickMap,
        (c) => evaluateCandidate(c, false),
        { limit: 36 },
      );

      let approxCollateralStrandedUsd = {};
      for (const row of residualDiagnosticRows) {
        const rk = row.primaryBlocker ?? "caps_too_strict";
        approxCollateralStrandedUsd[rk] =
          (approxCollateralStrandedUsd[rk] ?? 0) + (Number(row.capitalPerContract) || 0);
      }

      const potentialPremiumStrandedUsd = residualDiagnosticRows.reduce(
        (sum, row) =>
          premiumClusterLeakKeys.has(row.primaryBlocker)
            ? sum + Number(row.premiumPerContract || 0)
            : sum,
        0,
      );

      const replacementClusterHints = [...residualDiagnosticRows]
        .filter(
          (r) =>
            premiumClusterLeakKeys.has(r.primaryBlocker) || r.primaryBlocker === "max_positions_limit",
        )
        .sort((a, b) => (b.wedgeDensity ?? 0) - (a.wedgeDensity ?? 0))
        .slice(0, 14)
        .map((row) => ({
          ticker: row.ticker,
          primaryBlocker: row.primaryBlocker,
          blockerLabelFr: formatCapBlockerReason(row.primaryBlocker),
          collateralUsd: row.capitalPerContract,
          premiumUsdPerLot: row.premiumPerContract,
          wedgeDensity: row.wedgeDensity,
        }));

      const mergedBlockers = summarizeBlockerHits(rejectionTotals, residualDiagnosticRows);

      /** État résiduel final — après construction complète des picks — pour diagnostic knapsack (lecture seule). */
      const residualFreeUsd = usableCapital - used;
      let couldAddStrictResidual = false;
      let couldAddSoftResidualOnly = false;
      for (const cScan of scoredPool) {
        if (evaluateCandidate(cScan, false).ok) {
          couldAddStrictResidual = true;
          break;
        }
      }
      if (!couldAddStrictResidual) {
        for (const cScan of scoredPool) {
          if (evaluateCandidate(cScan, true).ok) {
            couldAddSoftResidualOnly = true;
            break;
          }
        }
      }
      const residualFiniteCollateral = scoredPool
        .map((z) => Number(z.capitalPerContract))
        .filter((q) => Number.isFinite(q) && q > 0);
      const smallestPoolCollateralUsd =
        residualFiniteCollateral.length ? Math.min(...residualFiniteCollateral) : null;

      const sortedByCheap = [...scoredPool].sort(
        (a, b) => (Number(a.capitalPerContract) || 0) - (Number(b.capitalPerContract) || 0),
      );
      let cheapestEligibleFailCandidate = null;
      for (const ccheap of sortedByCheap) {
        const evCheap = evaluateCandidate(ccheap, false);
        if (!evCheap.ok) {
          cheapestEligibleFailCandidate = {
            ticker: ccheap.ticker,
            capitalRequired: ccheap.capitalPerContract,
            reasonNotAdded: evCheap.reason ?? "caps_too_strict",
          };
          break;
        }
      }

      const nextBestCandidatesResidual = residualDiagnosticRows.slice(0, 14).map((row) => {
        const canon = scoredPool.find((sp) => sp.ticker === row.ticker);
        const blocker = row.primaryBlocker ?? "caps_too_strict";
        const capReq = Number(row.capitalPerContract);
        let missingUsd = null;
        if (
          blocker === "contract_size_too_large" &&
          Number.isFinite(capReq) &&
          Number.isFinite(residualFreeUsd)
        ) {
          missingUsd = Math.max(0, capReq - residualFreeUsd);
        }
        return {
          ticker: row.ticker,
          mode: canon?.finalDisplayMode ?? canon?.mode ?? null,
          capitalRequired: row.capitalPerContract,
          missingCapital:
            blocker === "contract_size_too_large"
              ? missingUsd
              : null,
          yieldPct:
            canon?.weeklyReturn ??
            canon?.selectedYieldPct ??
            null,
          score:
            canon?._comboScoreBreakdown?.totalScore ?? canon?.allocScore ?? null,
          blockerTypeDiagnostic:
            blocker,
          reasonNotAdded: `${blocker} · après allocation greedy (voir cycleTrace même timestamp logique bucket)`,
        };
      });

      const stoppedPieces = [];
      if (residualFreeUsd <= 0.01) stoppedPieces.push("deployable_residual_usd_floor_reached_near_zero_cent");
      if (picks.length >= maxPositionLines) stoppedPieces.push(`portfolio_distinct_lines_hit_max_${maxPositionLines}`);
      if (
        smallestPoolCollateralUsd != null &&
        residualFreeUsd + 1e-6 < smallestPoolCollateralUsd &&
        picks.length < maxPositionLines
      ) {
        stoppedPieces.push(
          `residual_collateral_below_smallest_per_contract_ticket_in_filtered_pool_approx_${smallestPoolCollateralUsd.toFixed(0)}_usd_gap_knapsack`,
        );
      }
      if (!couldAddStrictResidual && !couldAddSoftResidualOnly && picks.length < maxPositionLines && residualFreeUsd > 0.01) {
        stoppedPieces.push("aucun_strict_ni_soft_evaluate_candidate_ok_avec_etat_actuelvoir_rejectionTotals");
      }
      if (capitalShortfallReason) stoppedPieces.push(`capital_shortfall_label_${capitalShortfallReason}`);
      const stoppedBecauseTrace =
        stoppedPieces.length > 0
          ? [...new Set(stoppedPieces)].join(" · ")
          : "allocation_greedy_exited_under_normal_terminal_conditions_no_extra_residual_flags_emitted";

      const allocationTraceV1 =
        diagnosticsEnabledForTrace && traceAccum
          ? {
              bucket: mode.label ?? "unknown_bucket_label",
              requestedMaxPositions: maxPositions ?? null,
              effectiveMaxPositions: maxPositionLines ?? null,
              minTargetDistinctLinesPolicy: minTargetPositions ?? null,
              startingCapital: usableCapital,
              startingCapitalUsableEnvelope:
                usableCapital,
              finalUsedCapital: used,
              finalFreeCapital: residualFreeUsd,
              finalDistinctLines:
                picks.length,
              finalPositionCount:
                picks.length,
              stoppedBecause: stoppedBecauseTrace,
              cycleTrace: [...traceAccum.cycleRows],
              selectedTrace: [...traceAccum.selectedRows],
              rejectionTrace: [...traceAccum.rejectionRows],
              residualAnalysis: {
                freeCapital:
                  residualFreeUsd,
                nextBestCandidates: nextBestCandidatesResidual,
                cheapestEligibleCandidate: cheapestEligibleFailCandidate,
                couldAddAnyCandidateWithResidual:
                  couldAddStrictResidual || couldAddSoftResidualOnly,
                couldStrictFitResidualAudit:
                  !!couldAddStrictResidual,
                couldSoftContractCapFitResidualAudit:
                  !!couldAddSoftResidualOnly,
                smallestContractCollateralUsdInFilteredPool:
                  smallestPoolCollateralUsd,
                alternateOrderingKnapsackNotSimulatedNoteFr:
                  "Aucune optimisation exhaustive sac-à-dos ou permutation d’ordo simulée en Phase 2A ; consulter allocationTrace.cycleTrace et blockerSummaryMerged.",
              },
              leftoverDensityPassTrace: {
                enabledGlobal: leftoverDensityGlobalEnabledFlag,
                enabledForBucket: !!leftoverV2EligibleMode,
                safeBucketLeftoverExplicitlyDisabledPolicy: !!conservativeLeftoverIsPolicyOff,
                attempted: leftoverDensityLoopEnteredTrace,
                adds:
                  leftoverV2Adds,
                reasonNoAdd:
                  leftoverV2Adds === 0
                    ? finalizeLeftoverReasonNoAdds()
                    : `n_a_positive_add_counter_${leftoverV2Adds}_see_density_sweep_iterations`,
                leftoverMinPctOfUsable:
                  optimizerV2.leftoverMinPctOfUsable ?? null,
                leftoverMinAbsoluteUsd:
                  optimizerV2.leftoverMinAbsoluteUsd ?? null,
                crumbThresholdUsdSnapshot:
                  leftoverDensityCrumbUsdTrace,
                minEligibleContractUsdSnapshotPrePass:
                  leftoverDensityMinContractUsdTrace,
                candidatesConsidered: leftoverDensityIterationsRanTrace,
                breakReasonDetailed:
                  leftoverDensityPassBreakReasonTrace,
                candidatesRejected: [...traceAccum.leftoverRejectSamples],
                instrumentationNoteSafeLeftoverDefaultsFr:
                  mode.id === "conservative"
                    ? optimizerV2.safeLeftoverDensityPassEnabled !== true
                      ? "SAFE : passe leftover désactivée par défaut tant que safeLeftoverDensityPassEnabled=false (voir wheelCapitalComboOptimizerV2Flags / localStorage)."
                      : "SAFE : passe leftover activée côté config — si adds=0, utiliser reasonNoAdd + breakReasonDetailed."
                    : "Balanced/aggressive suivent leftoverDensityPassEnabled globale sans clé SAFE additionnelle.",
              },
              traceTruncationSignalsV1: {
                cycleRowCapConfigured: CYCLE_ROWS_CAP,
                rejectionRowCapConfigured: REJECTION_ROWS_CAP,
                cycleRowsLogged: traceAccum.cycleRows.length,
                rejectionRowsLogged: traceAccum.rejectionRows.length,
                maybeTruncatedCycles: traceAccum.cycleRows.length >= CYCLE_ROWS_CAP,
                maybeTruncatedRejections: traceAccum.rejectionRows.length >= REJECTION_ROWS_CAP,
              },
            }
          : null;

      const alternativeCompositionSimV1 = buildAlternativeCompositionSimV1({
        bucketLabel: mode.label,
        modeId: mode.id,
        scoredPool,
        modeAlloc,
        usableCapital,
        grossCapital: capital,
        maxPositionsRequested: maxPositions,
        effectiveMaxLines: maxPositionLines,
        minTargetPositions,
        baselinePicks: picks,
        optimizerV2,
      });

      capDiagnosticsV2 = {
        engineVersion: "capital-combo-v2.1-dashboard",
        flagsSnapshot: { ...optimizerV2 },
        fillEfficiencyPct: usedPct,
        rejectionTotalsAcrossCycles: Object.fromEntries([...rejectionTotals.entries()].sort()),
        blockerSummaryMerged: mergedBlockers,
        nextBestResiduals: residualDiagnosticRows.slice(0, 22),
        approxCollateralBlockedUsdByReason: approxCollateralStrandedUsd,
        potentialPremiumStrandedUsd,
        leftoverDensityPass: {
          enabled: leftoverV2EligibleMode,
          adds: leftoverV2Adds,
          premiumDeltaUsd: leftoverV2PremiumDelta,
          premiumBaselineUsd: premiumBeforeDensityPass,
        },
        replacementHints: replacementClusterHints,
        institutionalYieldV3: balancedInstitutionalV3Audit,
        balancedEffectiveMaxPositions: mode.id === "balanced" ? maxPositionLines : null,
        dominantFillBlocker: mergedBlockers[0] ?? null,
        lostPremiumNoteFr:
          potentialPremiumStrandedUsd > 10
            ? `Prime théorique encore bloquée par caps (est.) ≈ ${potentialPremiumStrandedUsd.toFixed(0)}$ — voir replacementHints / nextBestResiduals.`
            : null,
        balancedPerPickInsights:
          mode.id === "balanced" && balancedInstitutionalV3Audit
            ? picks.map((p) => {
                const c = Number(p.capitalUsed ?? 0);
                const pr = Number(p.premiumCollected ?? 0);
                return {
                  ticker: p.ticker,
                  phase: p.comboAllocationPhase ?? null,
                  selectionSummary: p.selectionSummary ?? null,
                  whyKeptFr: p.selectionReason ?? null,
                  premiumUsdPer1000Collateral: c > 0 ? (pr / c) * 1000 : null,
                  shareOfDeployablePct: usableCapital > 0 ? (c / usableCapital) * 100 : null,
                  weeklyYieldPct: p.weeklyReturn,
                  popPct: p.popEstimate,
                };
              })
            : null,
        allocationTraceV1,
        alternativeCompositionSimV1,
      };
    }

    const picksOut =
      mode.id === "balanced" && balancedInstitutionalV3Audit
        ? picks.map((p) => {
            const c = Number(p.capitalUsed ?? 0);
            const pr = Number(p.premiumCollected ?? 0);
            return {
              ...p,
              balancedInstitutionalV3Pick: {
                whyInBookFr: p.selectionReason ?? null,
                allocPhase: p.comboAllocationPhase ?? null,
                premiumUsdPer1000Collateral: c > 0 ? (pr / c) * 1000 : null,
                deployableCapitalSharePct: usableCapital > 0 ? (c / usableCapital) * 100 : null,
              },
            };
          })
        : picks;

    return {
      label: mode.label,
      positions: picksOut.length,
      totalCapital: used,
      capitalPct: capital > 0 ? (used / capital) * 100 : 0,
      capitalTargetReached: usedPct >= targetMinPct,
      capitalShortfallReason,
      avgWeeklyReturn: avgWeekly,
      freeCapital: capital - used,
      picks: picksOut,
      balancedInstitutionalV3Audit: mode.id === "balanced" ? balancedInstitutionalV3Audit : null,
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
      totalPremiumCollected,
      capDiagnosticsV2,
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
