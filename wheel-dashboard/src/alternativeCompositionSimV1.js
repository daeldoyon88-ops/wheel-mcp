/**
 * Phase 2B — Simulation read-only de compositions alternatives (Inspector / capDiagnosticsV2).
 * Ne modifie pas la sélection live ; uniquement diagnostics versionnés.
 */

const NEUTRAL_CLUSTER_KEYS = new Set(["unknown", "none", "no_theme", "other", ""]);

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function nmean(arr) {
  const v = arr.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function wmeanByCapital(picks, accessor) {
  let sx = 0;
  let sw = 0;
  for (const p of picks || []) {
    const w = Number(p?.capitalUsed ?? NaN);
    const x = Number(accessor(p));
    if (!Number.isFinite(w) || w <= 0 || !Number.isFinite(x)) continue;
    sx += x * w;
    sw += w;
  }
  return sw > 0 ? sx / sw : null;
}

function gradeRank(g) {
  const u = String(g || "").toUpperCase();
  if (u === "A") return 3;
  if (u === "B") return 2;
  if (u === "WATCH") return 1;
  return 0;
}

function lookupCandidateRow(pool, ticker) {
  const t = String(ticker || "").trim().toUpperCase();
  return pool.find((c) => String(c?.ticker || "").trim().toUpperCase() === t) ?? null;
}

/** Concentration / diversification alignés sur la logique Phase 4D-4 du portefeuille capital. */
function clusterMetricsFromPicks(picks, usedCapital) {
  const tickerCapMapConc = new Map();
  const themeCapMapConc = new Map();
  const NEUTRAL_THEMES_SET = new Set(["unknown", "none", "no_theme", "other", ""]);
  for (const p of picks || []) {
    const cap = Number(p?.capitalUsed ?? 0);
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const tk = p.ticker;
    tickerCapMapConc.set(tk, (tickerCapMapConc.get(tk) ?? 0) + cap);
    const theme = p.concentrationTheme;
    if (theme != null && !NEUTRAL_THEMES_SET.has(theme)) {
      themeCapMapConc.set(theme, (themeCapMapConc.get(theme) ?? 0) + cap);
    }
  }
  const used = usedCapital > 0 ? usedCapital : [...tickerCapMapConc.values()].reduce((s, x) => s + x, 0);
  const largestTickerCapitalPct =
    used > 0 && tickerCapMapConc.size > 0 ? (Math.max(...tickerCapMapConc.values()) / used) * 100 : 0;
  const cryptoMinerCapitalPct = used > 0 ? ((themeCapMapConc.get("crypto_miner") ?? 0) / used) * 100 : 0;
  const highBetaCapitalPct = used > 0 ? ((themeCapMapConc.get("high_beta_growth") ?? 0) / used) * 100 : 0;
  const largestThemeCapitalPct =
    used > 0 && themeCapMapConc.size > 0 ? (Math.max(...themeCapMapConc.values()) / used) * 100 : 0;
  const concentrationRiskScore = clamp01(
    0.35 * clamp01(largestTickerCapitalPct / 25) +
      0.35 * clamp01(largestThemeCapitalPct / 45) +
      0.2 * clamp01(cryptoMinerCapitalPct / 35) +
      0.1 * clamp01(highBetaCapitalPct / 40),
  );
  const diversificationHealthScore = clamp01(1 - concentrationRiskScore);
  return {
    largestTickerCapitalPct,
    largestThemeCapitalPct,
    concentrationRiskScore,
    diversificationHealthScore,
  };
}

/**
 * Score composite simulation uniquement (ne remplace aucun score métier).
 */
export function computeSimCompositePortfolioScore(picks, usableCapital) {
  const used = (picks || []).reduce((s, p) => s + Number(p?.capitalUsed ?? 0), 0);
  const prem = (picks || []).reduce((s, p) => s + Number(p?.premiumCollected ?? 0), 0);
  const avgQ = nmean(picks.map((p) => p?.qualityScore));
  const avgPop = nmean(picks.map((p) => p?.popEstimate));
  const avgDist = nmean(picks.map((p) => p?.distancePct));
  const avgSp = nmean(picks.map((p) => p?.spreadPct));
  const avgY = wmeanByCapital(picks, (p) => p?.weeklyReturn);
  const { concentrationRiskScore, diversificationHealthScore } = clusterMetricsFromPicks(picks, used);

  let earningsPenaltyCount = 0;
  let dataGapCount = 0;
  for (const p of picks || []) {
    const qs = (p?.qualityWarnings || []).join(" ").toLowerCase();
    if (qs.includes("earnings")) earningsPenaltyCount += 1;
    if (p?.popEstimate == null || p?.distancePct == null || p?.spreadPct == null) dataGapCount += 1;
  }
  const n = picks?.length || 0;
  const earningsPenaltyNorm = n ? (earningsPenaltyCount / n) * 9 : 0;
  const dataQualityPenalty = n ? (dataGapCount / n) * 7 : 0;

  const qualityComponent = (avgQ != null ? avgQ : 0.5) * 26;
  const premiumComponent = usableCapital > 0 ? Math.min(22, (prem / usableCapital) * 140) : 0;
  const capitalEfficiencyComponent =
    usableCapital > 0 ? clamp01(used / usableCapital) * 16 : 0;

  let popComponent = 0;
  if (avgPop != null) {
    popComponent = clamp01((avgPop - 72) / 22) * 12;
  } else {
    popComponent = 3;
    dataGapCount += 1;
  }

  let distanceComponent = 4;
  if (avgDist != null && avgDist <= 0) {
    distanceComponent = clamp01(Math.min(12, Math.abs(avgDist) / 10)) * 11;
  } else if (avgDist != null) {
    distanceComponent = clamp01(1 - avgDist / 6) * 6;
  }

  let liquidityComponent = 5;
  if (avgSp != null) {
    liquidityComponent = clamp01((20 - Math.min(35, avgSp)) / 20) * 10;
  }

  const diversificationComponent = diversificationHealthScore * 14;
  const concentrationPenalty = concentrationRiskScore * 18;
  const earningsPenalty = earningsPenaltyNorm;
  const dataQualityPenaltyAdj = dataQualityPenalty;

  const total =
    qualityComponent +
    premiumComponent +
    capitalEfficiencyComponent +
    popComponent +
    distanceComponent +
    liquidityComponent +
    diversificationComponent -
    concentrationPenalty -
    earningsPenalty -
    dataQualityPenaltyAdj;

  return {
    simCompositePortfolioScore: Number.isFinite(total) ? total : null,
    simScoreBreakdownV1: {
      qualityComponent,
      premiumComponent,
      capitalEfficiencyComponent,
      popComponent,
      distanceComponent,
      liquidityComponent,
      diversificationComponent,
      concentrationPenalty,
      earningsPenalty,
      dataQualityPenalty: dataQualityPenaltyAdj,
      total,
    },
    avgWeeklyYieldPct: avgY,
  };
}

function buildPickFromSelection(candidate, selectionReason, comboAllocationPhase = "sim") {
  return {
    ticker: candidate.ticker,
    mode: candidate.finalDisplayMode,
    grade: candidate.finalDisplayGrade,
    strike: candidate.selectedStrike?.strike,
    source: candidate.source,
    premiumKind: candidate.premiumKind,
    premiumUnit: candidate.selectedStrike?.premiumUnit,
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
    selectionReason,
    comboAllocationPhase,
  };
}

export class VirtualAllocator {
  constructor(scoredPool, modeAlloc, usableCapital, maxPositionLines, minTargetPositions) {
    this.scoredPool = scoredPool;
    this.modeAlloc = modeAlloc;
    this.usableCapital = usableCapital;
    this.maxPositionLines = maxPositionLines;
    this.minTargetPositions = minTargetPositions;
    this.tickerCapDollars = usableCapital * modeAlloc.tickerCapPct;
    this.positionCapDollars = usableCapital * modeAlloc.positionCapPct;
    this.picks = [];
    this.pickMap = new Map();
    this.used = 0;
  }

  computePortfolioState() {
    const tickerCapitalMap = new Map();
    const themeCapitalMap = new Map();
    const sectorCapitalMap = new Map();
    let highBetaCapital = 0;
    let cryptoMinerPositions = 0;
    let speculativePositions = 0;
    for (const pick of this.picks) {
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
      distinctPositions: this.picks.length,
    };
  }

  canAddByComposition(candidate, state) {
    const maxCrypto = this.modeAlloc.maxCryptoMinerPositions;
    const maxSpec = this.modeAlloc.maxSpeculativePositions;
    if (maxCrypto == null && maxSpec == null) return { ok: true };
    const ov = candidate._qualityOverlay;
    const theme = ov?.concentrationTheme ?? null;
    const tier = ov?.qualityTier ?? null;
    if (maxCrypto != null && theme === "crypto_miner") {
      const currentCrypto = state.cryptoMinerPositions;
      const hardMax = this.modeAlloc.maxCryptoMinerExceptionCount ?? maxCrypto;
      if (currentCrypto >= hardMax) return { ok: false, reason: "theme_cap_reached" };
      if (currentCrypto >= maxCrypto) {
        const pop = candidate._popForCombo;
        const spread = candidate.spreadPct;
        const quality = ov?.qualityScore ?? 0;
        const ok =
          pop != null &&
          pop >= (this.modeAlloc.maxCryptoMinerExceptionPopMin ?? 82) &&
          (spread == null || spread <= (this.modeAlloc.maxCryptoMinerExceptionSpreadMax ?? 20)) &&
          quality >= (this.modeAlloc.maxCryptoMinerExceptionQualityMin ?? 0.65);
        if (!ok) return { ok: false, reason: "theme_cap_reached" };
      }
    }
    if (maxSpec != null && tier === "speculative") {
      const currentSpec = state.speculativePositions;
      if (currentSpec >= maxSpec) return { ok: false, reason: "caps_too_strict" };
    }
    return { ok: true };
  }

  hasDiversifyingAlternative(state, excludedTicker = "") {
    return this.scoredPool.some((candidate) => {
      if (candidate.ticker === excludedTicker) return false;
      if (this.pickMap.has(candidate.ticker)) return false;
      if (candidate.capitalPerContract <= 0) return false;
      if (this.used + candidate.capitalPerContract > this.usableCapital) return false;
      if (state.distinctPositions >= this.maxPositionLines) return false;
      if (candidate.capitalPerContract > this.tickerCapDollars) return false;
      if (candidate.capitalPerContract > this.positionCapDollars) return false;
      if (!this.canAddByComposition(candidate, state).ok) return false;
      const nextDistinctPositions = state.distinctPositions + 1;
      if (nextDistinctPositions >= this.minTargetPositions) {
        const themeKey = String(candidate?._qualityOverlay?.concentrationTheme || "").trim().toLowerCase();
        const sectorKey = String(candidate?._tickerMeta?.sector || "").trim().toLowerCase();
        if (themeKey && !NEUTRAL_CLUSTER_KEYS.has(themeKey)) {
          const nextThemeCapital = (state.themeCapitalMap.get(themeKey) ?? 0) + candidate.capitalPerContract;
          if (nextThemeCapital > this.usableCapital * (this.modeAlloc.maxThemeCapitalPct ?? 0.45)) return false;
        }
        if (sectorKey && !NEUTRAL_CLUSTER_KEYS.has(sectorKey)) {
          const nextSectorCapital = (state.sectorCapitalMap.get(sectorKey) ?? 0) + candidate.capitalPerContract;
          if (nextSectorCapital > this.usableCapital * (this.modeAlloc.maxSectorCapitalPct ?? 0.45)) return false;
        }
        const nextHighBetaCapital =
          state.highBetaCapital +
          (candidate?._qualityOverlay?.concentrationTheme === "high_beta_growth" ? candidate.capitalPerContract : 0);
        if (nextHighBetaCapital > this.usableCapital * (this.modeAlloc.maxHighBetaCapitalPct ?? 0.4)) return false;
      }
      return true;
    });
  }

  projectLargestPct(map, key, nextCapital, nextUsed) {
    const nextMap = new Map(map);
    if (key) nextMap.set(key, (nextMap.get(key) ?? 0) + nextCapital);
    if (nextUsed <= 0 || nextMap.size === 0) return 0;
    return (Math.max(...nextMap.values()) / nextUsed) * 100;
  }

  projectDynamicPenalty(state, candidate, nextUsed, isExisting, nextTickerCapital) {
    const themeKey = String(candidate?._qualityOverlay?.concentrationTheme || "").trim().toLowerCase();
    const sectorKey = String(candidate?._tickerMeta?.sector || "").trim().toLowerCase();
    const largestTickerPct = nextUsed > 0 ? (nextTickerCapital / nextUsed) * 100 : 0;
    const largestThemePct = this.projectLargestPct(
      state.themeCapitalMap,
      themeKey && !NEUTRAL_CLUSTER_KEYS.has(themeKey) ? themeKey : null,
      candidate.capitalPerContract,
      nextUsed,
    );
    const largestSectorPct = this.projectLargestPct(
      state.sectorCapitalMap,
      sectorKey && !NEUTRAL_CLUSTER_KEYS.has(sectorKey) ? sectorKey : null,
      candidate.capitalPerContract,
      nextUsed,
    );
    const nextHighBetaCapital =
      state.highBetaCapital +
      (candidate?._qualityOverlay?.concentrationTheme === "high_beta_growth" ? candidate.capitalPerContract : 0);
    const nextHighBetaPct = nextUsed > 0 ? (nextHighBetaCapital / nextUsed) * 100 : 0;
    const tickerCapSoftPct = (Number(this.modeAlloc.tickerCapPct) || 0.3) * 100;
    const themeCapSoftPct = (Number(this.modeAlloc.maxThemeCapitalPct) || 0.45) * 100;
    const sectorCapSoftPct = (Number(this.modeAlloc.maxSectorCapitalPct) || 0.45) * 100;
    const highBetaCapSoftPct = (Number(this.modeAlloc.maxHighBetaCapitalPct) || 0.4) * 100;
    let penalty = 0;
    penalty += Math.max(0, largestTickerPct - tickerCapSoftPct) * 0.9;
    penalty += Math.max(0, largestThemePct - themeCapSoftPct) * 0.55;
    penalty += Math.max(0, largestSectorPct - sectorCapSoftPct) * 0.45;
    penalty += Math.max(0, nextHighBetaPct - highBetaCapSoftPct) * 0.6;
    if (isExisting) penalty += 6;
    return { penalty };
  }

  evaluateCandidate(candidate, useSoftCaps = false) {
    const existing = this.pickMap.get(candidate.ticker);
    const isExisting = !!existing;
    const currentContracts = existing?.contracts ?? 0;
    const state = this.computePortfolioState();
    const nextUsed = this.used + candidate.capitalPerContract;
    const maxContractsAllowed = useSoftCaps
      ? this.modeAlloc.maxContractsPerTicker + 1
      : this.modeAlloc.maxContractsPerTicker;
    const nextPositionCapital = (currentContracts + 1) * candidate.capitalPerContract;
    const tickerCapLimit = useSoftCaps ? this.tickerCapDollars * 1.1 : this.tickerCapDollars;
    const positionCapLimit = useSoftCaps ? this.positionCapDollars * 1.1 : this.positionCapDollars;
    const nextDistinctPositions = isExisting ? state.distinctPositions : state.distinctPositions + 1;

    if (candidate.capitalPerContract <= 0) return { ok: false, reason: "contract_size_too_large" };
    if (currentContracts >= maxContractsAllowed) return { ok: false, reason: "ticker_cap_reached" };
    if (
      this.modeAlloc.maxBitxContracts != null &&
      String(candidate.ticker).toUpperCase() === "BITX" &&
      currentContracts >= this.modeAlloc.maxBitxContracts
    ) {
      return { ok: false, reason: "ticker_cap_reached" };
    }
    if (candidate._isWatchPremium && currentContracts >= (this.modeAlloc.maxWatchPremiumContracts ?? 1)) {
      return { ok: false, reason: "ticker_cap_reached" };
    }
    if (!isExisting && state.distinctPositions >= this.maxPositionLines) return { ok: false, reason: "max_positions_limit" };
    if (nextUsed > this.usableCapital) return { ok: false, reason: "contract_size_too_large" };
    if (nextPositionCapital > tickerCapLimit || nextPositionCapital > positionCapLimit) {
      return { ok: false, reason: "ticker_cap_reached" };
    }

    const composition = this.canAddByComposition(candidate, state);
    if (!composition.ok) return { ok: false, reason: composition.reason ?? "caps_too_strict" };

    if (
      isExisting &&
      state.distinctPositions < this.minTargetPositions &&
      this.hasDiversifyingAlternative(state, candidate.ticker)
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
      state.highBetaCapital +
      (candidate?._qualityOverlay?.concentrationTheme === "high_beta_growth" ? candidate.capitalPerContract : 0);
    const enforceClusterCaps =
      nextDistinctPositions >= this.minTargetPositions || !this.hasDiversifyingAlternative(state, candidate.ticker);

    if (enforceClusterCaps) {
      if (nextTickerCapital > this.usableCapital * this.modeAlloc.tickerCapPct) {
        return { ok: false, reason: "ticker_cap_reached" };
      }
      if (
        themeKey &&
        !NEUTRAL_CLUSTER_KEYS.has(themeKey) &&
        nextThemeCapital > this.usableCapital * (this.modeAlloc.maxThemeCapitalPct ?? 0.45)
      ) {
        return { ok: false, reason: "theme_cap_reached" };
      }
      if (
        sectorKey &&
        !NEUTRAL_CLUSTER_KEYS.has(sectorKey) &&
        nextSectorCapital > this.usableCapital * (this.modeAlloc.maxSectorCapitalPct ?? 0.45)
      ) {
        return { ok: false, reason: "sector_cap_reached" };
      }
      if (nextHighBetaCapital > this.usableCapital * (this.modeAlloc.maxHighBetaCapitalPct ?? 0.4)) {
        return { ok: false, reason: "high_beta_cap_reached" };
      }
    }

    const projected = this.projectDynamicPenalty(state, candidate, nextUsed, isExisting, nextTickerCapital);
    const diversificationBonus = !isExisting ? (state.distinctPositions < this.minTargetPositions ? 16 : 7) : 0;
    const marginalScore = Number(candidate.allocScore ?? 0) + diversificationBonus - projected.penalty;
    const selectionReasonParts = [candidate._comboScoreBreakdown?.selectionReason ?? "selected: portfolio fit (sim)"];
    if (!isExisting && state.distinctPositions < this.minTargetPositions) {
      selectionReasonParts.push("portfolio sim: nouvelle ligne priorisée pour diversification");
    } else if (!isExisting) {
      selectionReasonParts.push("portfolio sim: diversification ajoutée sans dégrader le budget");
    } else {
      selectionReasonParts.push("portfolio sim: renfort accepté après caps et diversification");
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

  applySelection(selection, phase) {
    const { candidate, existing, isExisting, selectionReason } = selection;
    if (!isExisting) {
      const pick = buildPickFromSelection(candidate, selectionReason, phase);
      this.picks.push(pick);
      this.pickMap.set(candidate.ticker, pick);
    } else {
      existing.contracts += 1;
      existing.capitalUsed += candidate.capitalPerContract;
      existing.premiumCollected += candidate.premiumPerContract;
      existing.selectionScore = Math.max(
        existing.selectionScore ?? 0,
        candidate._comboScoreBreakdown?.totalScore ?? candidate.allocScore ?? 0,
      );
      existing.selectionReason = selectionReason;
      existing.comboAllocationPhase = phase;
    }
    this.used += candidate.capitalPerContract;
  }

  pickBestPrimary(stepScore, useSoftCaps) {
    let best = null;
    let bestKey = -Infinity;
    for (const candidate of this.scoredPool) {
      const evaluated = this.evaluateCandidate(candidate, useSoftCaps);
      if (!evaluated.ok) continue;
      const key = stepScore(evaluated, candidate);
      const alloc = candidate.allocScore ?? 0;
      const bestAlloc = best?.candidate?.allocScore ?? 0;
      if (
        !best ||
        key > bestKey ||
        (key === bestKey && alloc > bestAlloc) ||
        (key === bestKey && alloc === bestAlloc && String(candidate.ticker) < String(best.candidate.ticker))
      ) {
        best = evaluated;
        bestKey = key;
      }
    }
    return best;
  }

  pickBestFiller(fillerScoreFn) {
    const freeCapital = this.usableCapital - this.used;
    if (freeCapital <= 0) return null;
    let best = null;
    let bestKey = -Infinity;
    for (const candidate of this.scoredPool) {
      if (candidate.capitalPerContract <= 0 || candidate.capitalPerContract > freeCapital) continue;
      let evaluated = this.evaluateCandidate(candidate, false);
      let usedSoftCaps = false;
      if (!evaluated.ok) {
        const softEvaluated = this.evaluateCandidate(candidate, true);
        if (!softEvaluated.ok) continue;
        evaluated = softEvaluated;
        usedSoftCaps = true;
      }
      const freeAfter = freeCapital - candidate.capitalPerContract;
      const key = fillerScoreFn(evaluated, candidate, freeCapital, freeAfter, usedSoftCaps);
      const tieAlloc = candidate.allocScore ?? 0;
      const bestAlloc = best?.candidate?.allocScore ?? 0;
      if (
        !best ||
        key > bestKey ||
        (key === bestKey && freeAfter < (best._freeAfter ?? Infinity)) ||
        (key === bestKey && freeAfter === best._freeAfter && tieAlloc > bestAlloc)
      ) {
        best = { ...evaluated, _freeAfter: freeAfter };
        bestKey = key;
      }
    }
    return best;
  }

  runSimulation(modeId, primaryScoreFn, fillerScoreFn, targetGoalPct = 95, forcedFirstTicker = null) {
    const forcedTk = forcedFirstTicker != null ? String(forcedFirstTicker).trim().toUpperCase() : "";
    if (forcedTk) {
      const cand = this.scoredPool.find((c) => String(c?.ticker || "").trim().toUpperCase() === forcedTk);
      if (cand) {
        const ev = this.evaluateCandidate(cand, false);
        if (ev.ok) {
          this.applySelection(ev, "sim_forced_first");
        }
      }
    }
    while (true) {
      const best = this.pickBestPrimary(primaryScoreFn, false);
      if (best) {
        this.applySelection(best, "sim_primary_strict");
        continue;
      }
      const pct = this.usableCapital > 0 ? (this.used / this.usableCapital) * 100 : 0;
      if (pct >= targetGoalPct) break;
      const softBest = this.pickBestPrimary(primaryScoreFn, true);
      if (!softBest) break;
      this.applySelection(softBest, "sim_primary_soft");
    }
    if (modeId !== "conservative") {
      while (true) {
        const fillerBest = this.pickBestFiller(fillerScoreFn);
        if (!fillerBest) break;
        this.applySelection(fillerBest, "sim_filler");
      }
    }
    return this.picks;
  }
}

function simMyopicBalanced(evaluated, candidate) {
  const pop = candidate._popForCombo;
  const q = candidate._qualityOverlay?.qualityScore ?? 0.5;
  const dist = candidate.selectedDistancePct ?? 0;
  const sp = candidate.selectedSpreadPct ?? 18;
  const earnPen = candidate._qualityOverlay?.earningsPenalty ?? 0;
  const popTerm = pop != null ? clamp01((pop - 74) / 20) * 42 : 9;
  const distTerm = dist <= 0 ? Math.min(28, Math.abs(dist) * 1.1) : Math.max(0, 10 + dist);
  const liqTerm = Math.max(0, 22 - Math.min(30, sp));
  return (
    0.42 * (candidate.allocScore ?? 0) +
    popTerm +
    16 * q +
    distTerm +
    0.35 * liqTerm +
    (evaluated.isExisting ? 0 : 9) +
    0.65 * (evaluated.marginalScore ?? 0) -
    earnPen * 28
  );
}

export function makeFillerFn(usableCapitalEnvelope) {
  return (evaluated, candidate, freeCapital, freeAfter, usedSoftCaps) => {
  const deployEfficiency = 1 - freeAfter / Math.max(1, freeCapital);
  const smallC = 1 - Math.min(1, candidate.capitalPerContract / Math.max(1, usableCapitalEnvelope));
  const premiumEfficiency = Math.max(0, candidate.weeklyReturn ?? 0);
  const diversificationBonus = evaluated.isExisting ? 0 : 1.8;
  const watchPenalty = candidate._isWatchPremium ? 1.2 : 0;
  const speculativePenalty = candidate._qualityOverlay?.qualityTier === "speculative" ? 1.4 : 0;
  return (
    Number(evaluated.marginalScore ?? 0) +
    deployEfficiency * 16 +
    premiumEfficiency * 9 +
    smallC * 4 +
    diversificationBonus -
    watchPenalty -
    speculativePenalty -
    (usedSoftCaps ? 0.4 : 0)
  );
  };
}

function ftqsProxy(cand) {
  const raw = Number(cand?.finalTradeQualityScore);
  if (Number.isFinite(raw)) return raw;
  const q = cand._qualityOverlay?.qualityScore ?? null;
  if (q != null) return q * 100;
  return 40 + 18 * gradeRank(cand.finalDisplayGrade);
}

export function buildCompositionSnapshot(picks, usableCapital, grossCapital, scoredPool) {
  const used = picks.reduce((s, p) => s + Number(p.capitalUsed ?? 0), 0);
  const prem = picks.reduce((s, p) => s + Number(p.premiumCollected ?? 0), 0);
  const distinct = new Set(picks.map((p) => p.ticker)).size;
  const contracts = picks.reduce((s, p) => s + Number(p.contracts ?? 1), 0);
  const tickers = [...new Set(picks.map((p) => p.ticker))];
  const { simCompositePortfolioScore, simScoreBreakdownV1, avgWeeklyYieldPct } = computeSimCompositePortfolioScore(
    picks,
    usableCapital,
  );
  const avgYield = nmean(picks.map((p) => p.weeklyReturn));
  const wYield = wmeanByCapital(picks, (p) => p.weeklyReturn);
  const avgPop = nmean(picks.map((p) => p.popEstimate));
  const avgSpread = nmean(picks.map((p) => p.spreadPct));
  const avgDistance = nmean(picks.map((p) => p.distancePct));
  const avgQuality = nmean(picks.map((p) => p.qualityScore));
  const avgElite = nmean(
    picks.map((p) => {
      const c = lookupCandidateRow(scoredPool, p.ticker);
      return c?.eliteScore != null ? Number(c.eliteScore) : null;
    }),
  );
  const avgFtqs = nmean(
    picks.map((p) => {
      const c = lookupCandidateRow(scoredPool, p.ticker);
      return c?.finalTradeQualityScore != null ? Number(c.finalTradeQualityScore) : null;
    }),
  );
  const avgSel = nmean(picks.map((p) => p.selectionScore));
  const { concentrationRiskScore, diversificationHealthScore, largestTickerCapitalPct, largestThemeCapitalPct } =
    clusterMetricsFromPicks(picks, used);
  const fillPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
  const notes = [];
  if (largestThemeCapitalPct <= 0.01) notes.push("Métrique thème : aucun thème non neutre significatif dans cette composition.");
  const sectorKnown = picks.some((p) => p.sectorKey && !NEUTRAL_CLUSTER_KEYS.has(String(p.sectorKey).toLowerCase()));
  if (!sectorKnown) notes.push("Secteur : plusieurs tickers sans secteur connu dans tickerMeta — diversification sectorielle sim approximative.");

  return {
    tickers,
    distinctLines: distinct,
    totalContracts: contracts,
    usedCapital: used,
    freeCapital: grossCapital - used,
    fillEfficiencyPct: fillPct,
    premiumTotalUsd: prem,
    avgYieldPct: avgYield,
    weightedYieldPct: wYield ?? avgWeeklyYieldPct,
    avgPop,
    avgSpreadPct: avgSpread,
    avgDistancePct: avgDistance,
    avgQualityScore: avgQuality,
    avgEliteScore: avgElite,
    avgFinalTradeQualityScore: avgFtqs,
    concentrationScore: concentrationRiskScore,
    diversificationScore: diversificationHealthScore,
    riskScore: concentrationRiskScore,
    compositePortfolioScore: simCompositePortfolioScore,
    simCompositePortfolioScore,
    simScoreBreakdownV1,
    avgSelectionScore: avgSel,
    dominantConcentrationTickerPct: largestTickerCapitalPct,
    dominantThemePct: largestThemeCapitalPct,
    notes,
  };
}

function candidateRowsFromPicks(picks, scoredPool, reasonIncludedPrefix) {
  return picks.map((p) => {
    const c = lookupCandidateRow(scoredPool, p.ticker);
    return {
      ticker: p.ticker,
      mode: p.mode ?? c?.finalDisplayMode ?? null,
      capitalRequired: p.capitalUsed ?? p.capitalRequired ?? null,
      premiumPerContract: p.premiumCollected != null ? Number(p.premiumCollected) : null,
      yieldPct: p.weeklyReturn ?? null,
      pop: p.popEstimate ?? null,
      spreadPct: p.spreadPct ?? null,
      distancePct: p.distancePct ?? null,
      grade: p.grade ?? null,
      eliteScore: c?.eliteScore != null ? Number(c.eliteScore) : null,
      finalTradeQualityScore: c?.finalTradeQualityScore != null ? Number(c.finalTradeQualityScore) : null,
      selectionScore: p.selectionScore ?? null,
      reasonIncluded:
        `${reasonIncludedPrefix} · ${p.comboAllocationPhase ?? "live_or_unknown"} · ${String(p.selectionReason ?? "").slice(0, 220)}`,
    };
  });
}

function compareAdvantages(baseSnap, candSnap) {
  const adv = [];
  const dis = [];
  const dt = (a, b, label, goodHigher, fmt = (x) => x.toFixed(2)) => {
    if (a == null || b == null) return;
    const d = b - a;
    if (Math.abs(d) < 1e-6) return;
    if (goodHigher ? d > 0 : d < 0) adv.push(`${label} ${goodHigher ? "meilleur" : "plus bas"} (${fmt(goodHigher ? b : a)} vs ${fmt(goodHigher ? a : b)})`);
    else dis.push(`${goodHigher ? "moins bon" : "plus élevé"} sur ${label} (${fmt(b)} vs ${fmt(a)})`);
  };
  dt(baseSnap.simCompositePortfolioScore, candSnap.simCompositePortfolioScore, "score composite sim", true);
  dt(baseSnap.usedCapital, candSnap.usedCapital, "capital utilisé", true);
  dt(baseSnap.premiumTotalUsd, candSnap.premiumTotalUsd, "prime totale", true);
  dt(baseSnap.diversificationScore, candSnap.diversificationScore, "diversification (sim)", true);
  dt(baseSnap.riskScore, candSnap.riskScore, "risque concentration (sim)", false);
  dt(baseSimDistinct(baseSnap), baseSimDistinct(candSnap), "lignes distinctes", true, (x) => String(x));
  return { adv, dis };
}

function baseSimDistinct(snap) {
  return snap.distinctLines ?? (snap.tickers?.length ?? 0);
}

/**
 * @param {object} params
 */
export function createBalancedVirtualAllocationScorers(usableCapitalEnvelope) {
  return {
    primaryScoreFn: (ev, cand) => simMyopicBalanced(ev, cand),
    fillerScoreFn: makeFillerFn(usableCapitalEnvelope),
  };
}

export function buildAlternativeCompositionSimV1(params) {
  const {
    bucketLabel,
    modeId,
    scoredPool,
    modeAlloc,
    usableCapital,
    grossCapital,
    maxPositionsRequested,
    effectiveMaxLines,
    minTargetPositions,
    baselinePicks,
    optimizerV2,
  } = params;

  if (optimizerV2?.capDiagnosticsEnabled === false) {
    return null;
  }

  const maxCand = scoredPool?.length ?? 0;
  const baseSnap = buildCompositionSnapshot(baselinePicks || [], usableCapital, grossCapital, scoredPool);
  const baselineCurrent = {
    source: "current_greedy_allocator",
    ...baseSnap,
    candidateRows: candidateRowsFromPicks(baselinePicks || [], scoredPool, "pick live greedy + passes finales"),
  };
  delete baselineCurrent.avgSelectionScore;
  delete baselineCurrent.dominantConcentrationTickerPct;
  delete baselineCurrent.dominantThemePct;

  const fillerFn = makeFillerFn(usableCapital);

  const mkFillPrimary = () => (ev, cand) =>
    18 * (cand.capitalPerContract / Math.max(1, usableCapital)) +
    0.00085 * (cand.premiumPerContract ?? 0) +
    0.45 * (ev.marginalScore ?? 0) +
    (ev.isExisting ? 0 : 2.1);

  const mkPremiumPrimary = () => (ev, cand) =>
    Number(cand.premiumPerContract ?? 0) + 0.18 * (ev.marginalScore ?? 0) - (cand._qualityOverlay?.premiumTrapPenalty ?? 0) * 40;

  const mkQualityPrimary = () => (ev, cand) => {
    const ft = ftqsProxy(cand);
    const elite = Number(cand.eliteScore);
    const eliteTerm = Number.isFinite(elite) ? elite * 0.35 : 0;
    return ft * 0.55 + eliteTerm + gradeRank(cand.finalDisplayGrade) * 10 + 0.22 * (ev.marginalScore ?? 0);
  };

  const mkDivPrimary = () => (ev, cand) => (ev.isExisting ? 0 : 620) + 0.85 * (ev.marginalScore ?? 0);

  const mkBalancedPrimary = () => (ev, cand) => simMyopicBalanced(ev, cand);

  const mkMoreLinesPrimary = () => (ev, cand) => simMyopicBalanced(ev, cand) + (ev.isExisting ? 0 : 4.2);

  const runVariant = (id, strategy, description, primaryScoreFn, maxLinesOverride) => {
    const maxL = maxLinesOverride ?? effectiveMaxLines;
    const mem = new VirtualAllocator(scoredPool, modeAlloc, usableCapital, maxL, minTargetPositions);
    const picks = mem.runSimulation(modeId, primaryScoreFn, fillerFn);
    const snap = buildCompositionSnapshot(picks, usableCapital, grossCapital, scoredPool);
    const { adv, dis } = compareAdvantages(baseSnap, snap);
    let rejection = null;
    if (snap.simCompositePortfolioScore != null && baseSnap.simCompositePortfolioScore != null) {
      if (snap.simCompositePortfolioScore < baseSnap.simCompositePortfolioScore - 0.45) {
        rejection = `Score sim inférieur d’au moins ~0,45 au baseline (${snap.simCompositePortfolioScore.toFixed(2)} vs ${baseSnap.simCompositePortfolioScore.toFixed(2)}).`;
      }
    }
    if (
      snap.riskScore != null &&
      baseSnap.riskScore != null &&
      snap.riskScore > baseSnap.riskScore + 0.12 &&
      snap.simCompositePortfolioScore != null &&
      baseSnap.simCompositePortfolioScore != null &&
      snap.simCompositePortfolioScore <= baseSnap.simCompositePortfolioScore + 0.2
    ) {
      rejection =
        (rejection ? rejection + " " : "") +
        "Concentration / risque sim nettement plus élevé sans gain composite clair — rejet comme « pas strictement meilleur ».";
    }
    const out = {
      id,
      strategy,
      description,
      ...snap,
      advantagesVsBaseline: adv,
      disadvantagesVsBaseline: dis,
      rejectionReasonIfNotBetter: rejection,
      candidateRows: candidateRowsFromPicks(picks, scoredPool, `simulation ${strategy}`),
    };
    delete out.avgSelectionScore;
    delete out.dominantConcentrationTickerPct;
    delete out.dominantThemePct;
    return out;
  };

  const alternativeCompositions = [
    runVariant(
      "ALT_FILL",
      "best_fill_efficiency",
      "Maximise l’enveloppe collatérale déployée (efficacité de remplissage prudente) tout en conservant une pondération marginalScore.",
      mkFillPrimary(),
    ),
    runVariant("ALT_PRIME", "best_premium_total", "Favorise la prime brute contractuelle, avec pénalité premium-trap du quality overlay.", mkPremiumPrimary()),
    runVariant(
      "ALT_QUALITY",
      "best_quality_weighted",
      "Favorise finalTradeQualityScore (proxy si absent), eliteScore, grade et marginalScore modéré.",
      mkQualityPrimary(),
    ),
    runVariant("ALT_DIV", "best_diversification", "Forte prime aux nouvelles lignes distinctes + marginalScore.", mkDivPrimary()),
    runVariant(
      "ALT_BALANCED",
      "balanced_risk_reward",
      "Compromis institutionnel myope (POP, qualité, distance, spread, marginalScore) calibré pour robustesse, pas prime aveugle.",
      mkBalancedPrimary(),
    ),
    runVariant(
      "ALT_SMALL",
      "smaller_but_better",
      `Même compromis « balanced », plafond effectif de lignes = max(1, baseline−1) = ${Math.max(1, baseSnap.distinctLines - 1)} (test sous-allocation).`,
      mkBalancedPrimary(),
      Math.max(1, baseSnap.distinctLines - 1),
    ),
    runVariant(
      "ALT_MORE",
      "more_lines_if_reasonable",
      "Même plafond de lignes qu’en live, mais bonus léger aux nouvelles lignes pour tester si l’élargissement aide sous objectif robustesse.",
      mkMoreLinesPrimary(),
    ),
  ];

  let leaderAlt = null;
  let leaderScore = -Infinity;
  for (const ac of alternativeCompositions) {
    const s = ac.simCompositePortfolioScore;
    if (s == null) continue;
    if (s > leaderScore) {
      leaderScore = s;
      leaderAlt = ac;
    }
  }

  const EPS = 0.55;
  const baseScore = baseSnap.simCompositePortfolioScore;
  const passesStrictBetter =
    leaderAlt &&
    leaderAlt.simCompositePortfolioScore != null &&
    baseScore != null &&
    leaderAlt.simCompositePortfolioScore > baseScore + EPS &&
    (leaderAlt.riskScore ?? 0) <= (baseSnap.riskScore ?? 0) + 0.09 &&
    !leaderAlt.rejectionReasonIfNotBetter;

  const isBetter = !!passesStrictBetter;

  const verdictBaselineOptimal = !isBetter;
  let confidence = "medium";
  if (maxCand < 6) confidence = "low";
  else if (maxCand > 40) confidence = "high";

  let explanationFr = "";
  if (isBetter && leaderAlt) {
    explanationFr = `Une alternative « ${leaderAlt.strategy} » bat le baseline greedy sur le score composite sim (+${(
      leaderAlt.simCompositePortfolioScore - baseScore
    ).toFixed(2)}), sans dégrader fortement le risque concentration sim ni déclencher les garde-fous « rejet heuristique ».`;
    explanationFr +=
      " Pourquoi le greedy live ne l’a probablement pas reproduite à l’identique : ordre des sweeps marginalScore, verrou diversification précoce, ou absence dans cette sim des itérations leftoverDensityV2 — voir allocationTraceV1.cycleTrace.";
  } else {
    explanationFr =
      "Aucune alternative heuristique testée ne passe tous les filtres « strictement meilleure » (score sim + seuil + risque + absence de rejet raisonné). ";
    if (
      leaderAlt &&
      leaderAlt.simCompositePortfolioScore != null &&
      baseScore != null &&
      leaderAlt.simCompositePortfolioScore > baseScore + 0.25
    ) {
      explanationFr += `Leader brut du lot : ${leaderAlt.strategy} (score sim ${leaderAlt.simCompositePortfolioScore.toFixed(
        2,
      )} vs ${baseScore.toFixed(2)})`;
      if (leaderAlt.rejectionReasonIfNotBetter) {
        explanationFr += ` — écarté car : ${leaderAlt.rejectionReasonIfNotBetter}`;
      } else if ((leaderAlt.riskScore ?? 0) > (baseSnap.riskScore ?? 0) + 0.09) {
        explanationFr +=
          " — risque concentration sim plus élevé que le baseline malgré un score brut supérieur (seuil prudence).";
      } else {
        explanationFr +=
          " — gain vs baseline sous le seuil EPS ou contraintes séquentielles différentes du greedy.";
      }
      explanationFr += " ";
    }
    explanationFr +=
      "Recherche non exhaustive : bruit de modèle possible ; croiser avec allocationTraceV1 et residualAnalysis.";
  }

  return {
    enabled: true,
    simulationOnly: true,
    changedLiveSelection: false,
    bucket: bucketLabel,
    objective: {
      maxLinesRequested: maxPositionsRequested,
      effectiveMaxLines,
      startingCapital: usableCapital,
      goal: "best_risk_reward_composition_up_to_max_lines_not_force_max_lines",
    },
    baselineCurrent,
    alternativeCompositions,
    bestAlternative: {
      id: leaderAlt ? leaderAlt.id : null,
      isBetterThanBaseline: !!isBetter,
      improvementSummary: (() => {
        if (!leaderAlt || baseScore == null || leaderAlt.simCompositePortfolioScore == null) return null;
        const d = leaderAlt.simCompositePortfolioScore - baseScore;
        if (isBetter) return `Meilleure alternative validée : ${leaderAlt.strategy} (Δ score sim ≈ +${d.toFixed(2)}).`;
        if (d > 0.15)
          return `Meilleur score brut parmi heuristiques : ${leaderAlt.strategy} (Δ ≈ +${d.toFixed(
            2,
          )}) mais non classée « strictement meilleure » — voir rejectionReasonIfNotBetter de cette ligne ou verdict.`;
        return null;
      })(),
      scoreDelta:
        leaderAlt && baseScore != null && leaderAlt.simCompositePortfolioScore != null
          ? leaderAlt.simCompositePortfolioScore - baseScore
          : null,
      capitalUsageDeltaUsd: leaderAlt ? leaderAlt.usedCapital - baseSnap.usedCapital : null,
      premiumDeltaUsd: leaderAlt ? leaderAlt.premiumTotalUsd - baseSnap.premiumTotalUsd : null,
      diversificationDelta:
        leaderAlt && baseSnap.diversificationScore != null && leaderAlt.diversificationScore != null
          ? leaderAlt.diversificationScore - baseSnap.diversificationScore
          : null,
      riskDelta:
        leaderAlt && baseSnap.riskScore != null && leaderAlt.riskScore != null
          ? leaderAlt.riskScore - baseSnap.riskScore
          : null,
    },
    verdict: {
      baselineSeemsOptimal: verdictBaselineOptimal,
      confidence,
      explanationFr,
      recommendedNextAction: verdictBaselineOptimal
        ? "Phase 2C seulement si tu veux un second-pass sac-à-dos / optimisation globale activable par flag ; sinon surveiller caps et ordre via allocationTraceV1."
        : "Comparer les lignes de l’alternative gagnante au baseline (tickers + raisons sim) avant toute modification de règles ; envisager Phase 2C contrôlée si l’écart se répète.",
    },
    simulationLimits: {
      maxCandidatesConsidered: maxCand,
      maxCompositionsGenerated: alternativeCompositions.length,
      exhaustiveSearchUsed: false,
      heuristicSearchUsed: true,
      reasonLimited:
        "Recherche heuristique greedy (strict→soft→filler) rejouée avec priorités alternatives ; pas de relecture exacte de leftoverDensityV2 ; pas de knapsack exhaustif. Secteurs/thèmes incomplets possiblement signalés dans notes.",
    },
  };
}
