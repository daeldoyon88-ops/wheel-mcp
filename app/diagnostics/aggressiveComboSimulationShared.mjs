/**
 * Helpers partagés entre simulations read-only AGGRESSIVE (Capital Combo / VirtualAllocator).
 * Aucun effet live — même copies de filtres que aggressiveOkloSwapSimulation.mjs.
 */

import { readFileSync } from "node:fs";

import {
  buildCapitalComboCandidate,
  buildCapitalComboPoolStats,
  buildCapitalComboScoreBreakdown,
  computeTickerQualityOverlay,
  getFinalDisplayRecommendation,
  getAggressivePriorityGrade,
  gradeLeg,
  getLegPremiumValue,
  getLegSpreadPct,
  getLegYieldPct,
  getLegDistancePct,
  getLegPopPct,
} from "../../wheel-dashboard/src/capitalComboPortfolio.js";

export const DEFAULT_BUILD_CRITERIA = {
  maxPrice: 200,
  minPrice: 10,
  minVolume: 1_000_000,
  maxContractCapital: 25_500,
  minMarketCapB: 5,
  requireLiquidOptions: true,
  requireWeeklyOptions: true,
  liquidityOtmProbePct: 5,
  categories: ["weekly", "core", "growth", "high_premium"],
  limit: 150,
};

export function auditStampLocal() {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
}

export function nextFridayYmd() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  while (d.getDay() !== 5) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().slice(0, 10);
}

export function readJsonSafe(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

export function extractShortlistFromExport(obj) {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj.shortlist)) return obj.shortlist;
  if (Array.isArray(obj.payload?.shortlist)) return obj.payload.shortlist;
  if (Array.isArray(obj.scanResult?.payload?.shortlist)) return obj.scanResult.payload.shortlist;
  return [];
}

/** Copie du bloc AGGRESSIVE `modeConfigs[0]` — doit rester aligné sur capitalComboPortfolio.js */
export function makeAggressiveModeAlloc(usableCapital, poolStats) {
  const mode = {
    id: "aggressive",
    label: "AGGRESSIVE",
    tickerCapPct: 0.35,
    positionCapPct: 0.35,
    maxContractsPerTicker: 4,
    minTargetPositions: 3,
    maxThemeCapitalPct: 0.5,
    maxSectorCapitalPct: 0.5,
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
        pop != null &&
        pop >= 85 &&
        (spread == null || spread <= 20) &&
        yld != null &&
        yld >= 0.90 &&
        dist != null &&
        dist <= -6
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
    maxCryptoMinerPositions: 1,
    maxCryptoMinerExceptionCount: 2,
    maxCryptoMinerExceptionPopMin: 82,
    maxCryptoMinerExceptionSpreadMax: 20,
    maxCryptoMinerExceptionQualityMin: 0.65,
    maxSpeculativePositions: 2,
    score: null,
    filterCandidate: (c) => {
      const ov = c._qualityOverlay;
      if (!ov) return true;
      if (ov.qualityTier === "avoid") return false;
      if (ov.premiumTrapPenalty >= 0.40 && (c._popForCombo == null || c._popForCombo < 82)) return false;
      if (ov.qualityTier === "speculative" && c.selectedSpreadPct != null && c.selectedSpreadPct > 20) return false;
      return true;
    },
  };
  mode.score = (c) => buildCapitalComboScoreBreakdown(c, mode, usableCapital, poolStats).totalScore;
  return mode;
}

export function mapScanItemToComboCandidate(item) {
  const spot = Number(item.currentPrice) || 0;
  const mapLeg = (leg) => {
    if (!leg || typeof leg !== "object") return null;
    const wy = Number(leg.weeklyYield);
    const weeklyYieldPct = Number.isFinite(wy) && wy > 0 ? wy * 100 : null;
    const strike = Number(leg.strike);
    const dist =
      spot > 0 && Number.isFinite(strike) ? ((strike - spot) / spot) * 100 : Number(leg.distancePct) || 0;
    const popRaw = leg.popEstimate;
    return {
      strike: leg.strike,
      bid: leg.bid,
      ask: leg.ask,
      premium: leg.premium,
      conservativePremium: leg.conservativePremium,
      premiumUsed: leg.premiumUsed ?? leg.conservativePremium ?? leg.bid,
      primeUsed: leg.primeUsed,
      mid: leg.premium ?? leg.mid,
      liquidity: leg.liquidity,
      weeklyYield: weeklyYieldPct,
      periodYield: weeklyYieldPct,
      distancePct: dist,
      popEstimate: popRaw,
      popProfitEstimated: popRaw,
      impliedVolatility: leg.impliedVolatility,
    };
  };

  const safeStrike = mapLeg(item.safeStrike);
  const aggressiveStrike = mapLeg(item.aggressiveStrike);
  const rec = getFinalDisplayRecommendation({
    safeStrike,
    aggressiveStrike,
    safeGrade: item.safeGrade ?? null,
    aggressiveGrade: item.aggressiveGrade ?? null,
    recommendationDiagnostics: item.recommendationDiagnostics ?? null,
  });

  return {
    ticker: String(item.symbol || "").trim().toUpperCase(),
    symbol: item.symbol,
    currentPrice: spot,
    safeStrike,
    aggressiveStrike,
    finalDisplayMode: rec.finalDisplayMode,
    finalDisplayGrade: rec.finalDisplayGrade,
    qualityScore: item.qualityScore ?? null,
    finalScore: item.finalScore ?? null,
    executionScore: item.executionScore ?? null,
    distanceScore: item.distanceScore ?? null,
    proExecutionScore: item.executionScore ?? null,
    proFinalScore: item.finalScore ?? null,
    proDistanceScore: item.distanceScore ?? null,
    dteDays: item.dteDays ?? null,
    passesFilter: item.passesFilter === true,
    optionsSource: item.liquiditySource ? "yahoo_strict" : "Yahoo fallback",
  };
}

export function getModeStrike(candidate, modeId) {
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

/** Résout la jambe AGGRESSIVE et applique les mêmes filtres que `makeCombo` avant allocation. */
export function resolveAggressiveBucketCandidate(candidate) {
  if (!candidate._hasAggLegValid) return { ok: false, reason: "NO_BUCKET_LEG_FOR_MODE" };

  const bucketLeg = candidate._aggLeg;
  const bucketStrikeValue = candidate._aggStrikeValue;
  const bucketPremium = getLegPremiumValue(bucketLeg);
  const bucketSpread = getLegSpreadPct(bucketLeg);
  const bucketYield = getLegYieldPct(bucketLeg, candidate);
  const bucketDistance = getLegDistancePct(bucketLeg);
  const bucketPop = getLegPopPct(bucketLeg);
  const resolvedCapital =
    Number.isFinite(bucketStrikeValue) && bucketStrikeValue > 0 ? bucketStrikeValue * 100 : candidate._aggCapital;
  const _aggDerivedGrade = gradeLeg({
    spreadPct: bucketSpread,
    weeklyYieldPct: bucketYield,
    popDecimal: bucketLeg?.popProfitEstimated ?? bucketLeg?.popEstimate,
  });
  const _aggStoredGrade = String(candidate?.aggressiveGrade ?? "").toUpperCase() || null;
  const resolvedGrade =
    getAggressivePriorityGrade({
      spreadPct: bucketSpread,
      weeklyYieldPct: bucketYield,
      popDecimal: bucketLeg?.popProfitEstimated ?? bucketLeg?.popEstimate,
      distancePct: bucketDistance,
    }) ??
    (_aggDerivedGrade !== "REJECT" ? _aggDerivedGrade : null) ??
    _aggStoredGrade;

  const cand0 = {
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
    premiumPerContract:
      Number.isFinite(bucketPremium) && bucketPremium > 0 ? bucketPremium * 100 : 0,
    finalDisplayGrade: resolvedGrade || candidate.finalDisplayGrade,
    weeklyReturn: bucketYield ?? candidate.weeklyReturn,
    spreadPct: bucketSpread ?? candidate.spreadPct,
    _qualityOverlay: computeTickerQualityOverlay({
      ...candidate,
      spreadPct: bucketSpread,
      weeklyReturn: bucketYield,
      _popForCombo: bucketPop,
    }),
  };

  return { ok: true, cand0 };
}

export function gateAggressiveScoredCandidate(modeAlloc, usableCapital, poolStats, cand0) {
  const cand = {
    ...cand0,
    selectedStrike: getModeStrike(cand0, modeAlloc.id),
    _comboScoreBreakdown: buildCapitalComboScoreBreakdown(cand0, modeAlloc, usableCapital, poolStats),
  };

  if (!(cand.capitalPerContract > 0 && cand.capitalPerContract <= usableCapital && cand.weeklyReturn > 0)) {
    return { ok: false, reason: "CAPITAL_OR_YIELD_GATE", cand };
  }
  const gradeOk =
    modeAlloc.allowedGrades?.has(cand.finalDisplayGrade) ||
    (cand.finalDisplayGrade === "WATCH" && modeAlloc.watchPremiumFilter?.(cand));
  if (!gradeOk) return { ok: false, reason: "GRADE_OR_WATCH_GATE", cand };

  const candWp = {
    ...cand,
    _isWatchPremium: cand.finalDisplayGrade === "WATCH" && !!modeAlloc.watchPremiumFilter?.(cand),
  };

  if (!(candWp.weeklyReturn >= modeAlloc.minWeeklyYield))
    return { ok: false, reason: "MIN_WEEKLY_YIELD_NOT_MET", cand: candWp };
  if (!(modeAlloc.maxWeeklyYield == null || candWp.weeklyReturn < modeAlloc.maxWeeklyYield))
    return { ok: false, reason: "MAX_WEEKLY_YIELD_BAND_OR_CAP_REJECT", cand: candWp };
  if (!(!Number.isFinite(candWp.proExecutionScore) || candWp.proExecutionScore >= modeAlloc.minExecutionScore))
    return { ok: false, reason: "MIN_EXECUTION_SCORE_NOT_MET", cand: candWp };
  if (!(candWp.spreadPct == null || candWp.spreadPct <= modeAlloc.maxSpreadPct))
    return { ok: false, reason: "MAX_SPREAD_PCT_EXCEEDED", cand: candWp };
  if (
    !(
      modeAlloc.minDistancePct == null ||
      candWp.selectedDistancePct == null ||
      candWp.selectedDistancePct <= modeAlloc.minDistancePct
    )
  ) {
    return { ok: false, reason: "MIN_DISTANCE_PCT_BUCKET_GATE_FAILED", cand: candWp };
  }
  if (modeAlloc.filterCandidate && !modeAlloc.filterCandidate(candWp))
    return { ok: false, reason: "MODE_SPECIFIC_QUALITY_OR_SPECULATIVE_FILTER", cand: candWp };

  const staged = {
    ...candWp,
    allocScore:
      (candWp._comboScoreBreakdown?.totalScore ?? modeAlloc.score(candWp)) -
      (candWp._isWatchPremium ? 15 : 0),
  };
  return { ok: true, staged };
}

export function buildAggressiveScoredStaging(comboCandidates, capital, maxCapitalPct, maxPositions, rejectedIbkrSymbols) {
  const usableCapital = capital * (maxCapitalPct / 100);
  const basePool = comboCandidates
    .filter((c) => !rejectedIbkrSymbols.has(String(c?.ticker || "").trim().toUpperCase()))
    .map((c) => buildCapitalComboCandidate(c, usableCapital))
    .filter((c) => c._isCapitalComboEligible);
  const poolStats = buildCapitalComboPoolStats(basePool);

  const modeAlloc = makeAggressiveModeAlloc(usableCapital, poolStats);

  const bucketResolvedPool = basePool.map((candidate) => {
    const r = resolveAggressiveBucketCandidate(candidate);
    if (!r.ok) return { ...candidate, _hasBucketLeg: false };
    return r.cand0;
  });

  const scoredStaging = [];
  for (const cand0 of bucketResolvedPool) {
    if (!cand0._hasBucketLeg) continue;
    const g = gateAggressiveScoredCandidate(modeAlloc, usableCapital, poolStats, cand0);
    if (!g.ok) continue;
    scoredStaging.push(g.staged);
  }

  scoredStaging.sort(
    (a, b) =>
      b.allocScore - a.allocScore ||
      b._comboGradeScore - a._comboGradeScore ||
      (b.selectedYieldPct ?? 0) - (a.selectedYieldPct ?? 0) ||
      (a.selectedSpreadPct ?? Number.POSITIVE_INFINITY) - (b.selectedSpreadPct ?? Number.POSITIVE_INFINITY) ||
      (a.selectedDistancePct ?? 0) - (b.selectedDistancePct ?? 0),
  );

  const feasibleDistinctTickers = new Set(scoredStaging.map((candidate) => candidate.ticker)).size;
  const minTargetPositions = Math.max(
    1,
    Math.min(Number(maxPositions) || 0, Number(modeAlloc.minTargetPositions ?? 3), feasibleDistinctTickers),
  );

  return {
    usableCapital,
    grossCapital: capital,
    scoredPool: scoredStaging,
    modeAlloc,
    basePool,
    maxPositionLines: maxPositions,
    minTargetPositions,
    poolStats,
  };
}

export function createPickFromStagedCandidate(candidate, selectionReason, comboAllocationPhase = "oklo_swap_sim") {
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

/**
 * @param {string} selectionReason
 * @param {string} comboAllocationPhase
 */
export function tryBuildStagedPickFromShortlistRow(
  shortlistItem,
  usableCapital,
  modeAlloc,
  poolStats,
  selectionReason,
  comboAllocationPhase,
) {
  const raw = mapScanItemToComboCandidate(shortlistItem);
  const built = buildCapitalComboCandidate(raw, usableCapital);
  const r = resolveAggressiveBucketCandidate(built);
  if (!r.ok) return { ok: false, reason: r.reason };
  const g = gateAggressiveScoredCandidate(modeAlloc, usableCapital, poolStats, r.cand0);
  if (!g.ok) return { ok: false, reason: g.reason, gateDetail: g.cand ?? null };
  const pick = createPickFromStagedCandidate(g.staged, selectionReason, comboAllocationPhase);
  return { ok: true, staged: g.staged, pick };
}

export function highBetaCapitalPct(picks, used) {
  let hb = 0;
  for (const p of picks || []) {
    if (p.isHighBeta === true || p.concentrationTheme === "high_beta_growth") hb += Number(p.capitalUsed ?? 0);
  }
  return used > 0 ? (hb / used) * 100 : 0;
}

export function summarizeSnapshotForJson(label, snap, picks, usableCapital, grossCapital) {
  const used = picks.reduce((s, p) => s + Number(p.capitalUsed ?? 0), 0);
  const bd = snap.simScoreBreakdownV1 ?? {};
  return {
    label,
    capitalUsedUsd: snap.usedCapital,
    capitalFreeUsd: snap.freeCapital,
    grossCapitalUsd: grossCapital,
    usableCapitalUsd: usableCapital,
    premiumTotalUsd: snap.premiumTotalUsd,
    portfolioYieldWeightedPct: snap.weightedYieldPct ?? snap.avgWeeklyYieldPct,
    popAvgPct: snap.avgPop,
    otmAvgPct: snap.avgDistancePct,
    diversificationHealthScore: snap.diversificationScore,
    concentrationRiskScore: snap.concentrationScore,
    highBetaCapitalPct: highBetaCapitalPct(picks, used),
    dominantTickerCapitalPct: snap.dominantConcentrationTickerPct,
    simCompositePortfolioScore: snap.simCompositePortfolioScore,
    penaltiesSimV1: {
      concentrationPenalty: bd.concentrationPenalty ?? null,
      earningsPenalty: bd.earningsPenalty ?? null,
      dataQualityPenalty: bd.dataQualityPenalty ?? null,
    },
    tickers: snap.tickers,
    distinctLines: snap.distinctLines,
  };
}

export function verdictVsBaseline(baseSnap, candSnap) {
  const parts = [];
  const bs = baseSnap.simCompositePortfolioScore;
  const cs = candSnap.simCompositePortfolioScore;
  if (bs != null && cs != null) {
    const d = cs - bs;
    if (d > 0.35) parts.push(`meilleur score composite sim (+${d.toFixed(2)})`);
    else if (d < -0.35) parts.push(`score composite sim plus faible (${d.toFixed(2)})`);
    else parts.push("score composite sim ≈ baseline");
  }
  const yb = baseSnap.weightedYieldPct ?? baseSnap.avgWeeklyYieldPct;
  const yc = candSnap.weightedYieldPct ?? candSnap.avgWeeklyYieldPct;
  if (yb != null && yc != null) {
    const dy = yc - yb;
    if (Math.abs(dy) > 0.015)
      parts.push(dy > 0 ? `yield pondéré +${dy.toFixed(3)} pts` : `yield pondéré ${dy.toFixed(3)} pts`);
  }
  const dp = candSnap.premiumTotalUsd - baseSnap.premiumTotalUsd;
  if (Math.abs(dp) > 0.5) parts.push(dp > 0 ? `prime totale +${dp.toFixed(0)} $` : `prime totale ${dp.toFixed(0)} $`);
  const div =
    candSnap.diversificationScore != null && baseSnap.diversificationScore != null
      ? candSnap.diversificationScore - baseSnap.diversificationScore
      : null;
  if (div != null && Math.abs(div) > 0.02)
    parts.push(div > 0 ? `diversification sim +${div.toFixed(3)}` : `diversification sim ${div.toFixed(3)}`);
  return parts.join(" · ") || "proche du baseline";
}

export function pickBestScenario(scenarios) {
  let best = null;
  let bestScore = -Infinity;
  for (const s of scenarios) {
    const sc = s.summary?.simCompositePortfolioScore;
    if (sc == null || !Number.isFinite(sc)) continue;
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

function dNum(a, b) {
  if (a == null || b == null || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return b - a;
}

/** Deltas vs résumé baseline greedy (summarizeSnapshotForJson). */
export function deltaSummaryVsGreedyBaseline(baselineSummary, candidateSummary) {
  return {
    deltaCompositeScore: dNum(baselineSummary.simCompositePortfolioScore, candidateSummary.simCompositePortfolioScore),
    deltaCapitalUsedUsd: dNum(baselineSummary.capitalUsedUsd, candidateSummary.capitalUsedUsd),
    deltaCapitalFreeUsd: dNum(baselineSummary.capitalFreeUsd, candidateSummary.capitalFreeUsd),
    deltaPremiumUsd: dNum(baselineSummary.premiumTotalUsd, candidateSummary.premiumTotalUsd),
    deltaYieldWeightedPct: dNum(
      baselineSummary.portfolioYieldWeightedPct,
      candidateSummary.portfolioYieldWeightedPct,
    ),
    deltaPopAvgPct: dNum(baselineSummary.popAvgPct, candidateSummary.popAvgPct),
    deltaOtmAvgPct: dNum(baselineSummary.otmAvgPct, candidateSummary.otmAvgPct),
    deltaDiversificationScore: dNum(
      baselineSummary.diversificationHealthScore,
      candidateSummary.diversificationHealthScore,
    ),
    deltaConcentrationRiskScore: dNum(
      baselineSummary.concentrationRiskScore,
      candidateSummary.concentrationRiskScore,
    ),
    deltaHighBetaCapitalPct: dNum(baselineSummary.highBetaCapitalPct, candidateSummary.highBetaCapitalPct),
    deltaDominantTickerCapitalPct: dNum(
      baselineSummary.dominantTickerCapitalPct,
      candidateSummary.dominantTickerCapitalPct,
    ),
    deltaPenaltyConcentration: dNum(
      baselineSummary.penaltiesSimV1?.concentrationPenalty,
      candidateSummary.penaltiesSimV1?.concentrationPenalty,
    ),
    deltaPenaltyEarnings: dNum(
      baselineSummary.penaltiesSimV1?.earningsPenalty,
      candidateSummary.penaltiesSimV1?.earningsPenalty,
    ),
    deltaPenaltyDataQuality: dNum(
      baselineSummary.penaltiesSimV1?.dataQualityPenalty,
      candidateSummary.penaltiesSimV1?.dataQualityPenalty,
    ),
  };
}

export function finalPositionsFromPicks(picks) {
  return (picks || []).map((p) => ({
    ticker: p.ticker,
    contracts: p.contracts ?? 1,
    capitalUsedUsd: p.capitalUsed,
    premiumCollectedUsd: p.premiumCollected,
    weeklyReturnPct: p.weeklyReturn,
    popEstimate: p.popEstimate,
    otmDistancePct: p.distancePct,
    grade: p.grade,
    comboAllocationPhase: p.comboAllocationPhase ?? null,
  }));
}
