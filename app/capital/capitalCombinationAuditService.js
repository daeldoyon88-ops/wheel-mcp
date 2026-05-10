/**
 * Capital Combination Audit Service — Phase 4D
 *
 * PASSIVE / READ-ONLY MODULE
 * ─────────────────────────────────────────────────────────────────
 * This module performs mathematical verification and risk analysis
 * of the three capital combination modes (conservative / balanced /
 * aggressive).  It touches NOTHING outside its own computation:
 *
 *   appliedToScanner    : false — scanner is NOT modified
 *   appliedToRanking    : false — ranking is NOT modified
 *   appliedToEliteScore : false — EliteScore is NOT modified
 *   noLiveFetch         : true  — no Yahoo / IBKR fetch
 *   noDbWrite           : true  — pure computation, no persistence
 */

const AUDIT_VERSION = "4D.1";

// ─── Low-level helpers ────────────────────────────────────────────────────────

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(part, whole) {
  if (!whole || whole === 0) return null;
  return (part / whole) * 100;
}

// ─── computePositionMetrics ───────────────────────────────────────────────────
/**
 * Validates a single position object.
 * Accepts both the native dashboard.jsx pick format and the simplified format.
 *
 * Native format (dashboard.jsx makeCombo):
 *   { ticker, strike, contracts, premiumUnit, capitalUsed, premiumCollected, weeklyReturn }
 *
 * Simplified format (manual test):
 *   { ticker, strike, contracts, premium }
 *
 * Capital identity:   capitalUsed     = strike × 100 × contracts
 * Premium identity:   premiumCollected = premiumUnit × 100 × contracts
 * Yield identity:     weeklyReturn     = premiumUnit / strike × 100  (%)
 */
export function computePositionMetrics(position) {
  const ticker = String(position?.ticker ?? "").toUpperCase().trim();
  const strike = toNum(position?.strike);
  const contracts = toNum(position?.contracts);

  // premiumUnit = per-share premium (accept several field aliases)
  const premiumUnit = toNum(
    position?.premiumUnit ??
    position?.premium_unit ??
    position?.premium ??
    0
  );

  // Totals already in the payload (may be absent for simplified format)
  const capitalUsedPayload = toNum(
    position?.capitalUsed ?? position?.capital_used ?? position?.capital_required ?? 0
  );
  const premiumCollectedPayload = toNum(
    position?.premiumCollected ?? position?.total_premium ?? position?.premium_collected ?? 0
  );
  const weeklyReturnPayload = toNum(
    position?.weeklyReturn ?? position?.yield_pct ?? position?.weekly_return ?? 0
  );

  const warnings = [];

  // Recompute expected totals from first principles
  const expectedCapital = strike > 0 && contracts > 0 ? strike * 100 * contracts : 0;
  const expectedPremium = premiumUnit > 0 && contracts > 0 ? premiumUnit * 100 * contracts : 0;
  const expectedYield = expectedCapital > 0 && expectedPremium > 0
    ? (expectedPremium / expectedCapital) * 100
    : 0;

  // Prefer recomputed values; fall back to payload when payload lacks data
  const capitalUsed = expectedCapital > 0 ? expectedCapital : capitalUsedPayload;
  const premiumCollected = expectedPremium > 0 ? expectedPremium : premiumCollectedPayload;
  const weeklyReturn = weeklyReturnPayload > 0 ? weeklyReturnPayload : expectedYield;

  // ── Sanity checks ──────────────────────────────────────────────────────────

  if (strike <= 0) {
    warnings.push({ code: "INVALID_STRIKE", detail: `${ticker}: strike=${strike} is ≤ 0` });
  }
  if (contracts <= 0) {
    warnings.push({ code: "INVALID_CONTRACTS", detail: `${ticker}: contracts=${contracts} is ≤ 0` });
  }
  if (premiumUnit <= 0) {
    warnings.push({ code: "ZERO_PREMIUM", detail: `${ticker}: premiumUnit=${premiumUnit} is ≤ 0` });
  }

  // Capital mismatch (tolerance: $1)
  if (capitalUsedPayload > 0 && expectedCapital > 0 && Math.abs(capitalUsedPayload - expectedCapital) > 1) {
    warnings.push({
      code: "CAPITAL_MISMATCH",
      detail: `${ticker}: payload capitalUsed=${capitalUsedPayload} vs expected=${expectedCapital} (Δ=${Math.round(capitalUsedPayload - expectedCapital)})`,
    });
  }

  // Premium mismatch (tolerance: $0.50)
  if (premiumCollectedPayload > 0 && expectedPremium > 0 && Math.abs(premiumCollectedPayload - expectedPremium) > 0.5) {
    warnings.push({
      code: "PREMIUM_MISMATCH",
      detail: `${ticker}: payload premiumCollected=${premiumCollectedPayload} vs expected=${expectedPremium.toFixed(2)} (Δ=${(premiumCollectedPayload - expectedPremium).toFixed(2)})`,
    });
  }

  // Yield mismatch (tolerance: 0.01%)
  if (weeklyReturnPayload > 0 && expectedYield > 0 && Math.abs(weeklyReturnPayload - expectedYield) > 0.01) {
    warnings.push({
      code: "YIELD_MISMATCH",
      detail: `${ticker}: payload yield=${weeklyReturnPayload.toFixed(4)}% vs expected=${expectedYield.toFixed(4)}%`,
    });
  }

  // ── POP extraction ──────────────────────────────────────────────────────────
  const rawPop =
    position?.popEstimate ??
    position?.pop_estimate ??
    position?.pop ??
    position?.probabilityOfProfit ??
    position?.probability_of_profit ??
    null;

  let popEstimate = null;
  if (rawPop != null) {
    const numRaw = Number(rawPop);
    if (Number.isFinite(numRaw)) {
      const normalized = numRaw <= 1 ? numRaw * 100 : numRaw;
      if (normalized < 0 || normalized > 100) {
        warnings.push({
          code: "POP_INVALID",
          detail: `${ticker}: POP=${numRaw} normalizes to ${normalized.toFixed(2)}% — out of range [0,100]`,
        });
      } else {
        popEstimate = normalized;
      }
    }
  }

  if (popEstimate === null) {
    warnings.push({ code: "POP_MISSING", detail: `${ticker}: no valid POP estimate available` });
  } else {
    if (popEstimate < 80) {
      warnings.push({ code: "POP_LOW_80", detail: `${ticker}: popEstimate=${popEstimate.toFixed(1)}% < 80%` });
    }
    if (popEstimate < 85) {
      warnings.push({ code: "POP_LOW_85", detail: `${ticker}: popEstimate=${popEstimate.toFixed(1)}% < 85%` });
    }
  }

  // ── Quality overlay fields (passed through from dashboard pick) ──────────────
  const qualityTier = position?.qualityTier ?? null;
  const qualityScore = position?.qualityScore ?? null;
  const speculativePenalty = position?.speculativePenalty ?? null;
  const premiumTrapPenalty = position?.premiumTrapPenalty ?? null;
  const concentrationTheme = position?.concentrationTheme ?? null;
  const qualityWarnings = Array.isArray(position?.qualityWarnings) ? position.qualityWarnings : [];

  if (qualityTier === "avoid") {
    warnings.push({ code: "QUALITY_AVOID", detail: `${ticker}: qualityTier=avoid — position ne devrait pas figurer ici` });
  } else if (qualityTier === "speculative") {
    warnings.push({ code: "QUALITY_SPECULATIVE", detail: `${ticker}: qualityTier=speculative` });
  }
  if (premiumTrapPenalty != null && premiumTrapPenalty >= 0.30) {
    warnings.push({ code: "PREMIUM_TRAP", detail: `${ticker}: premiumTrapPenalty=${premiumTrapPenalty.toFixed(2)} ≥ 0.30` });
  }
  if (concentrationTheme === "crypto_miner") {
    warnings.push({ code: "THEME_CRYPTO_MINER", detail: `${ticker}: concentrationTheme=crypto_miner` });
  }

  return {
    ticker,
    strike,
    contracts,
    premiumUnit,
    capitalUsed,
    capitalExpected: expectedCapital,
    premiumCollected,
    premiumExpected: expectedPremium,
    weeklyReturn,
    yieldExpected: expectedYield,
    popEstimate,
    qualityTier,
    qualityScore,
    speculativePenalty,
    premiumTrapPenalty,
    concentrationTheme,
    qualityWarnings,
    warnings,
    ok: warnings.length === 0,
  };
}

// ─── computeModeMetrics ───────────────────────────────────────────────────────
/**
 * Computes aggregate metrics for a single mode (conservative / balanced /
 * aggressive).
 *
 * modeData: the combo object returned by makeCombo() in dashboard.jsx,
 *           or a simplified object with a `picks` or `positions` array.
 * accountCapital: full account size in dollars (used to compute free capital).
 */
export function computeModeMetrics(modeData, accountCapital) {
  const positions = Array.isArray(modeData?.picks)
    ? modeData.picks
    : Array.isArray(modeData?.positions)
      ? modeData.positions
      : [];

  const account = toNum(accountCapital ?? 0);

  // Payload-level totals (may be absent)
  const capitalUsedPayload = toNum(
    modeData?.totalCapital ?? modeData?.capital_used ?? modeData?.capitalUsed ?? 0
  );
  const freeCapitalPayload = toNum(
    modeData?.freeCapital ?? modeData?.free_capital ?? modeData?.capital_free ?? 0
  );
  const totalPremiumPayload = toNum(
    modeData?.totalPremium ?? modeData?.total_premium ?? modeData?.premiumCollected ?? 0
  );

  // Per-position audit
  const positionMetrics = positions.map(computePositionMetrics);

  // Recompute totals from positions
  let capitalUsed = 0;
  let totalPremium = 0;
  const tickerSet = new Set();

  for (const pm of positionMetrics) {
    capitalUsed += pm.capitalUsed;
    totalPremium += pm.premiumCollected;
    tickerSet.add(pm.ticker);
  }

  const capitalFree = account > 0 ? account - capitalUsed : freeCapitalPayload;
  const utilizationPct = account > 0 ? pct(capitalUsed, account) : null;
  const avgYieldPct = capitalUsed > 0 ? (totalPremium / capitalUsed) * 100 : 0;
  const premiumPer1000Capital = capitalUsed > 0 ? (totalPremium / capitalUsed) * 1000 : 0;

  // Concentration score: largest position's share of total used (0–1, lower is safer)
  const posCapitals = positionMetrics.map((p) => p.capitalUsed);
  const maxPosCap = posCapitals.length > 0 ? Math.max(...posCapitals) : 0;
  const concentrationScore = capitalUsed > 0 ? maxPosCap / capitalUsed : 0;

  // Diversification score (0–1, higher is better)
  const idealShare = positions.length > 0 ? 1 / positions.length : 1;
  const diversificationScore = Math.max(0, 1 - Math.max(0, concentrationScore - idealShare));

  // Risk score: blend of concentration + over-saturation
  const saturationRisk = utilizationPct != null ? Math.max(0, (utilizationPct - 90) / 10) : 0;
  const riskScore = Math.min(1, 0.6 * concentrationScore + 0.4 * saturationRisk);

  // Quality score: blend of yield and diversification
  const yieldScore = Math.min(1, avgYieldPct / 2); // 2% weekly ≈ perfect
  const qualityScore = 0.5 * yieldScore + 0.5 * diversificationScore;

  // ── POP metrics ─────────────────────────────────────────────────────────────
  const posWithPop = positionMetrics.filter((pm) => pm.popEstimate != null);
  let popAvg = null;
  let popWeightedByCapital = null;
  let popMin = null;
  let popBelow80Count = null;
  let popBelow85Count = null;
  let yieldPerPopRisk = null;
  let riskAdjustedPopScore = null;

  if (posWithPop.length > 0) {
    popAvg = posWithPop.reduce((s, pm) => s + pm.popEstimate, 0) / posWithPop.length;

    const capWithPop = posWithPop.reduce((s, pm) => s + pm.capitalUsed, 0);
    popWeightedByCapital = capWithPop > 0
      ? posWithPop.reduce((s, pm) => s + pm.popEstimate * pm.capitalUsed, 0) / capWithPop
      : null;

    popMin = Math.min(...posWithPop.map((pm) => pm.popEstimate));

    popBelow80Count = positionMetrics.filter(
      (pm) => pm.popEstimate != null && pm.popEstimate < 80
    ).length;
    popBelow85Count = positionMetrics.filter(
      (pm) => pm.popEstimate != null && pm.popEstimate < 85
    ).length;

    const refPop = popWeightedByCapital ?? popAvg ?? 0;
    yieldPerPopRisk = avgYieldPct / Math.max(1, 100 - refPop);
    riskAdjustedPopScore = avgYieldPct * (refPop / 100);
  }

  const warnings = [];

  if (posWithPop.length === 0 && positions.length > 0) {
    warnings.push({
      code: "POP_MODE_MISSING",
      detail: "No POP estimates available for any position in this mode",
    });
  }

  // Capital total mismatch (tolerance: $5)
  if (capitalUsedPayload > 0 && Math.abs(capitalUsed - capitalUsedPayload) > 5) {
    warnings.push({
      code: "CAPITAL_TOTAL_MISMATCH",
      detail: `Recomputed capitalUsed=${capitalUsed} vs payload=${capitalUsedPayload} (Δ=${Math.round(capitalUsed - capitalUsedPayload)})`,
    });
  }

  // Premium total mismatch (tolerance: $1)
  if (totalPremiumPayload > 0 && Math.abs(totalPremium - totalPremiumPayload) > 1) {
    warnings.push({
      code: "PREMIUM_TOTAL_MISMATCH",
      detail: `Recomputed totalPremium=${totalPremium.toFixed(2)} vs payload=${totalPremiumPayload} (Δ=${(totalPremium - totalPremiumPayload).toFixed(2)})`,
    });
  }

  // Free capital mismatch (tolerance: $5)
  if (account > 0 && freeCapitalPayload > 0 && Math.abs(capitalFree - freeCapitalPayload) > 5) {
    warnings.push({
      code: "FREE_CAPITAL_MISMATCH",
      detail: `Recomputed freeCapital=${capitalFree} vs payload=${freeCapitalPayload} (Δ=${Math.round(capitalFree - freeCapitalPayload)})`,
    });
  }

  // Over-saturation (>99%)
  if (utilizationPct != null && utilizationPct > 99) {
    warnings.push({
      code: "OVER_SATURATED",
      detail: `Capital utilization=${utilizationPct.toFixed(1)}% — less than 1% margin remaining`,
    });
  }

  // Under-utilization (<80%)
  if (utilizationPct != null && utilizationPct < 80) {
    warnings.push({
      code: "UNDER_UTILIZED",
      detail: `Capital utilization=${utilizationPct.toFixed(1)}% — over 20% capital idle`,
    });
  }

  // No positions
  if (positions.length === 0) {
    warnings.push({ code: "NO_POSITIONS", detail: "Mode has no positions" });
  }

  const positionWarnings = positionMetrics.flatMap((pm) =>
    pm.warnings.map((w) => ({ ...w, ticker: pm.ticker }))
  );

  // ── Quality overlay aggregate stats ─────────────────────────────────────────
  const posWithQuality = positionMetrics.filter((pm) => pm.qualityTier != null);
  let avgQualityScore = null;
  let avoidCount = 0;
  let speculativeCount = 0;
  let premiumTrapCount = 0;
  let cryptoMinerCount = 0;
  let highBetaGrowthCount = 0;

  if (posWithQuality.length > 0) {
    avgQualityScore =
      posWithQuality.reduce((s, pm) => s + (pm.qualityScore ?? 0), 0) / posWithQuality.length;
  }
  for (const pm of positionMetrics) {
    if (pm.qualityTier === "avoid") avoidCount++;
    if (pm.qualityTier === "speculative") speculativeCount++;
    if ((pm.premiumTrapPenalty ?? 0) >= 0.30) premiumTrapCount++;
    if (pm.concentrationTheme === "crypto_miner") cryptoMinerCount++;
    if (pm.concentrationTheme === "high_beta_growth") highBetaGrowthCount++;
  }

  return {
    positionCount: positions.length,
    capitalUsed,
    capitalFree,
    capitalUtilizationPct: utilizationPct,
    totalPremium,
    avgYieldPct,
    premiumPer1000Capital,
    estimatedReturnPct: avgYieldPct,
    concentrationScore,
    diversificationScore,
    riskScore,
    qualityScore,
    popAvg,
    popWeightedByCapital,
    popMin,
    popBelow80Count,
    popBelow85Count,
    yieldPerPopRisk,
    riskAdjustedPopScore,
    avgQualityScore,
    avoidCount,
    speculativeCount,
    premiumTrapCount,
    cryptoMinerCount,
    highBetaGrowthCount,
    warnings,
    positionWarnings,
    positionMetrics,
    ok: warnings.length === 0 && positionWarnings.length === 0,
  };
}

// ─── compareModes ─────────────────────────────────────────────────────────────
/**
 * Cross-mode comparison.  Detects structural inconsistencies between the
 * three modes and computes risk-adjusted metrics.
 *
 * All three arguments are the return values of computeModeMetrics().
 */
export function compareModes(conservative, balanced, aggressive) {
  const warnings = [];
  const insights = [];

  // ── Yield ordering ────────────────────────────────────────────────────────
  // Expected: aggressive.avgYieldPct ≥ balanced.avgYieldPct ≥ conservative.avgYieldPct

  const aggYield = aggressive?.avgYieldPct ?? 0;
  const balYield = balanced?.avgYieldPct ?? 0;
  const conYield = conservative?.avgYieldPct ?? 0;

  if (balanced && conservative && balYield < conYield) {
    warnings.push({
      code: "BALANCED_UNDERPERFORMS_CONSERVATIVE_YIELD",
      severity: "HIGH",
      detail: `Balanced yield/capital=${balYield.toFixed(3)}% < Conservative=${conYield.toFixed(3)}%. ` +
        `Balanced uses more capital but generates less premium per dollar. ` +
        `This means balanced is inferior to conservative in both utilization efficiency and return.`,
    });
  }

  if (aggressive && balanced && aggYield < balYield) {
    warnings.push({
      code: "AGGRESSIVE_UNDERPERFORMS_BALANCED_YIELD",
      severity: "MEDIUM",
      detail: `Aggressive yield/capital=${aggYield.toFixed(3)}% < Balanced=${balYield.toFixed(3)}%. ` +
        `Aggressive mode should command a higher premium per dollar for the additional risk taken.`,
    });
  }

  // ── Capital utilization ordering ──────────────────────────────────────────
  // Balanced should generally use more capital than conservative,
  // but should not exceed aggressive utilization while yielding less.

  const aggUtil = aggressive?.capitalUtilizationPct ?? 0;
  const balUtil = balanced?.capitalUtilizationPct ?? 0;
  const conUtil = conservative?.capitalUtilizationPct ?? 0;

  if (balanced && aggressive && balUtil > aggUtil && balUtil > 97) {
    warnings.push({
      code: "BALANCED_MORE_SATURATED_THAN_AGGRESSIVE",
      severity: "MEDIUM",
      detail: `Balanced utilization=${balUtil.toFixed(1)}% > Aggressive=${aggUtil.toFixed(1)}%. ` +
        `Counter-intuitive: the supposedly safer mode is more capital-saturated.`,
    });
  }

  if (conservative && conUtil < 75) {
    warnings.push({
      code: "CONSERVATIVE_UNDERFILLED",
      severity: "LOW",
      detail: `Conservative utilization=${conUtil.toFixed(1)}% — over 25% capital is idle. ` +
        `Consider whether the shortfall reason is structural (not enough candidates) or a caps issue.`,
    });
  }

  // ── Ticker overlap across modes ────────────────────────────────────────────
  const aggTickers = new Set((aggressive?.positionMetrics ?? []).map((p) => p.ticker));
  const balTickers = new Set((balanced?.positionMetrics ?? []).map((p) => p.ticker));
  const conTickers = new Set((conservative?.positionMetrics ?? []).map((p) => p.ticker));

  const inAll = [...aggTickers].filter((t) => balTickers.has(t) && conTickers.has(t));
  const overlapPct = aggTickers.size > 0 ? (inAll.length / aggTickers.size) * 100 : 0;

  if (inAll.length >= 4) {
    warnings.push({
      code: "HIGH_TICKER_OVERLAP_ACROSS_MODES",
      severity: "MEDIUM",
      detail: `${inAll.length} tickers appear in all 3 modes: [${inAll.join(", ")}]. ` +
        `Minimal differentiation between modes — a correlated market move would stress all three simultaneously.`,
    });
  }

  // ── Simultaneous assignment risk ──────────────────────────────────────────
  if (inAll.length >= 3) {
    warnings.push({
      code: "SIMULTANEOUS_ASSIGNMENT_RISK",
      severity: "MEDIUM",
      detail: `[${inAll.join(", ")}] are held in all modes. ` +
        `If multiple underlyings decline simultaneously, all three portfolio modes will be stressed at once.`,
    });
  }

  // ── Risk-adjusted return ──────────────────────────────────────────────────
  const aggRA = aggressive
    ? (aggressive.avgYieldPct ?? 0) / Math.max(0.01, aggressive.riskScore ?? 0.5)
    : 0;
  const balRA = balanced
    ? (balanced.avgYieldPct ?? 0) / Math.max(0.01, balanced.riskScore ?? 0.5)
    : 0;
  const conRA = conservative
    ? (conservative.avgYieldPct ?? 0) / Math.max(0.01, conservative.riskScore ?? 0.5)
    : 0;

  const bestRA =
    aggRA >= balRA && aggRA >= conRA
      ? "aggressive"
      : balRA >= conRA
        ? "balanced"
        : "conservative";

  insights.push({
    metric: "risk_adjusted_yield",
    description: "avgYieldPct / riskScore — higher is better",
    conservative: Number(conRA.toFixed(4)),
    balanced: Number(balRA.toFixed(4)),
    aggressive: Number(aggRA.toFixed(4)),
    best: bestRA,
  });

  insights.push({
    metric: "ticker_overlap_pct",
    value: Number(overlapPct.toFixed(1)),
    commonTickers: inAll,
    interpretation:
      overlapPct > 60
        ? "WARN: Modes share most tickers — limited cross-mode diversification"
        : "OK: Sufficient ticker differentiation between modes",
  });

  insights.push({
    metric: "capital_efficiency_ranking",
    description: "premiumPer1000Capital — higher means more premium collected per $1000 deployed",
    conservative: Number((conservative?.premiumPer1000Capital ?? 0).toFixed(4)),
    balanced: Number((balanced?.premiumPer1000Capital ?? 0).toFixed(4)),
    aggressive: Number((aggressive?.premiumPer1000Capital ?? 0).toFixed(4)),
  });

  // ── POP cross-mode insights ───────────────────────────────────────────────
  const conPop = conservative?.popWeightedByCapital ?? null;
  const balPop = balanced?.popWeightedByCapital ?? null;
  const aggPop = aggressive?.popWeightedByCapital ?? null;

  insights.push({
    metric: "pop_weighted_by_capital",
    description: "Capital-weighted POP average per mode — higher is safer",
    conservative: conPop != null ? Number(conPop.toFixed(2)) : null,
    balanced: balPop != null ? Number(balPop.toFixed(2)) : null,
    aggressive: aggPop != null ? Number(aggPop.toFixed(2)) : null,
  });

  const conRAS = conservative?.riskAdjustedPopScore ?? null;
  const balRAS = balanced?.riskAdjustedPopScore ?? null;
  const aggRAS = aggressive?.riskAdjustedPopScore ?? null;

  insights.push({
    metric: "risk_adjusted_pop_score",
    description: "avgYieldPct × (popWeightedByCapital / 100) — higher is better",
    conservative: conRAS != null ? Number(conRAS.toFixed(4)) : null,
    balanced: balRAS != null ? Number(balRAS.toFixed(4)) : null,
    aggressive: aggRAS != null ? Number(aggRAS.toFixed(4)) : null,
  });

  // Warning: aggressive yield higher but POP drops 8+ points vs balanced
  if (aggPop != null && balPop != null && aggYield > balYield && balPop - aggPop > 8) {
    warnings.push({
      code: "AGGRESSIVE_POP_PREMIUM_TRADEOFF",
      severity: "MEDIUM",
      detail:
        `Aggressive yield=${aggYield.toFixed(3)}% > Balanced=${balYield.toFixed(3)}% ` +
        `but POP weighted drops ${(balPop - aggPop).toFixed(1)} pts ` +
        `(${aggPop.toFixed(1)}% vs ${balPop.toFixed(1)}%). ` +
        `High yield premium comes at significant probability cost.`,
    });
  }

  // Warning: balanced similar/inferior yield vs conservative with similar/lower POP
  if (balPop != null && conPop != null && balYield <= conYield + 0.15 && balPop <= conPop + 1) {
    warnings.push({
      code: "BALANCED_NO_ADVANTAGE_OVER_CONSERVATIVE",
      severity: "MEDIUM",
      detail:
        `Balanced yield=${balYield.toFixed(3)}% vs Conservative=${conYield.toFixed(3)}% (similar or inferior) ` +
        `with POP=${balPop.toFixed(1)}% vs ${conPop.toFixed(1)}% (similar or lower). ` +
        `Balanced adds capital risk without return benefit.`,
    });
  }

  // Warning: balanced POP much lower than conservative without significantly higher yield
  if (balPop != null && conPop != null && conPop - balPop > 5 && balYield <= conYield + 0.30) {
    warnings.push({
      code: "BALANCED_POP_DEGRADATION_UNJUSTIFIED",
      severity: "MEDIUM",
      detail:
        `Balanced POP=${balPop.toFixed(1)}% is ${(conPop - balPop).toFixed(1)} pts below ` +
        `Conservative=${conPop.toFixed(1)}% without significantly higher yield ` +
        `(${balYield.toFixed(3)}% vs ${conYield.toFixed(3)}%).`,
    });
  }

  // Warning: conservative POP high but yield too low
  if (conPop != null && conYield < 0.40) {
    warnings.push({
      code: "CONSERVATIVE_YIELD_TOO_LOW",
      severity: "LOW",
      detail:
        `Conservative avgYieldPct=${conYield.toFixed(3)}% < 0.40% — ` +
        `POP is high (${conPop.toFixed(1)}%) but the return may be insufficient relative to capital deployed.`,
    });
  }

  // ── Quality overlay cross-mode warnings ──────────────────────────────────────
  const aggCryptoMiner = aggressive?.cryptoMinerCount ?? 0;
  const balSpeculative = balanced?.speculativeCount ?? 0;
  const aggSpeculative = aggressive?.speculativeCount ?? 0;
  const conSpeculative = conservative?.speculativeCount ?? 0;
  const conAvoid = conservative?.avoidCount ?? 0;

  if (aggCryptoMiner >= 3) {
    warnings.push({
      code: "AGGRESSIVE_TOO_MANY_CRYPTO_MINERS",
      severity: "HIGH",
      detail: `Aggressive contient ${aggCryptoMiner} positions crypto/miner — risque de corrélation extrême.`,
    });
  }

  if (balanced && aggressive && balSpeculative > 0 && balSpeculative >= aggSpeculative) {
    warnings.push({
      code: "BALANCED_SPECULATIVE_NOT_DIFFERENTIATED",
      severity: "MEDIUM",
      detail: `Balanced speculativeCount=${balSpeculative} ≥ Aggressive=${aggSpeculative}. Différenciation insuffisante entre les modes.`,
    });
  }

  if (conAvoid > 0) {
    warnings.push({
      code: "CONSERVATIVE_CONTAINS_AVOID_TIER",
      severity: "HIGH",
      detail: `Conservative contient ${conAvoid} position(s) qualityTier=avoid — ne devrait pas passer les filtres.`,
    });
  }

  const conSpecLowPop = (conservative?.positionMetrics ?? []).filter(
    (pm) => pm.qualityTier === "speculative" && (pm.popEstimate == null || pm.popEstimate < 88)
  ).length;
  if (conSpeculative > 0 && conSpecLowPop > 0) {
    warnings.push({
      code: "CONSERVATIVE_SPECULATIVE_LOW_POP",
      severity: "MEDIUM",
      detail: `Conservative: ${conSpecLowPop} position(s) speculative sans POP ≥ 88% — filtre trop permissif.`,
    });
  }

  insights.push({
    metric: "quality_overlay",
    description: "Distribution des tiers qualité par mode",
    conservative: {
      avgQualityScore: conservative?.avgQualityScore ?? null,
      avoidCount: conservative?.avoidCount ?? 0,
      speculativeCount: conservative?.speculativeCount ?? 0,
      premiumTrapCount: conservative?.premiumTrapCount ?? 0,
      cryptoMinerCount: conservative?.cryptoMinerCount ?? 0,
      highBetaGrowthCount: conservative?.highBetaGrowthCount ?? 0,
    },
    balanced: {
      avgQualityScore: balanced?.avgQualityScore ?? null,
      avoidCount: balanced?.avoidCount ?? 0,
      speculativeCount: balanced?.speculativeCount ?? 0,
      premiumTrapCount: balanced?.premiumTrapCount ?? 0,
      cryptoMinerCount: balanced?.cryptoMinerCount ?? 0,
      highBetaGrowthCount: balanced?.highBetaGrowthCount ?? 0,
    },
    aggressive: {
      avgQualityScore: aggressive?.avgQualityScore ?? null,
      avoidCount: aggressive?.avoidCount ?? 0,
      speculativeCount: aggressive?.speculativeCount ?? 0,
      premiumTrapCount: aggressive?.premiumTrapCount ?? 0,
      cryptoMinerCount: aggressive?.cryptoMinerCount ?? 0,
      highBetaGrowthCount: aggressive?.highBetaGrowthCount ?? 0,
    },
  });

  // ── Structural risk conclusion ────────────────────────────────────────────
  const highWarnings = warnings.filter((w) => w.severity === "HIGH").length;
  const medWarnings = warnings.filter((w) => w.severity === "MEDIUM").length;

  let structuralRisk = "LOW";
  if (highWarnings >= 1 || medWarnings >= 2) structuralRisk = "HIGH";
  else if (medWarnings >= 1) structuralRisk = "MEDIUM";

  return { warnings, insights, structuralRisk };
}

// ─── auditCapitalCombination ──────────────────────────────────────────────────
/**
 * Top-level audit entry point.
 *
 * Payload shape (flexible — accepts camelCase or snake_case aliases):
 * {
 *   accountCapital: 25500,
 *   conservative: { picks: [...], totalCapital: ..., freeCapital: ..., totalPremium: ... },
 *   balanced:     { picks: [...], ... },
 *   aggressive:   { picks: [...], ... },
 * }
 *
 * French aliases are also accepted:
 *   conservateur → conservative
 *   équilibré / equilibre → balanced
 *   agressif → aggressive
 */
export function auditCapitalCombination(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      auditVersion: AUDIT_VERSION,
      ok: false,
      error: "Invalid payload — must be a JSON object",
      passive: true,
      appliedToScanner: false,
      appliedToRanking: false,
      appliedToEliteScore: false,
    };
  }

  const accountCapital = toNum(
    payload?.accountCapital ??
    payload?.account_capital ??
    payload?.capitalAccount ??
    // Try to pull it from any mode sub-object
    payload?.conservative?.accountCapital ??
    payload?.balanced?.accountCapital ??
    payload?.aggressive?.accountCapital ??
    0
  );

  function findMode(englishKey, frenchAliases) {
    if (payload?.[englishKey] != null) return payload[englishKey];
    for (const alias of frenchAliases) {
      if (payload?.[alias] != null) return payload[alias];
    }
    return null;
  }

  const conservativeRaw = findMode("conservative", ["conservateur", "conservatif"]);
  const balancedRaw = findMode("balanced", ["equilibre", "équilibré", "equilbre"]);
  const aggressiveRaw = findMode("aggressive", ["agressif"]);

  const conservative = conservativeRaw ? computeModeMetrics(conservativeRaw, accountCapital) : null;
  const balanced = balancedRaw ? computeModeMetrics(balancedRaw, accountCapital) : null;
  const aggressive = aggressiveRaw ? computeModeMetrics(aggressiveRaw, accountCapital) : null;

  const comparison =
    conservative && balanced && aggressive
      ? compareModes(conservative, balanced, aggressive)
      : null;

  // Flatten all warnings for top-level summary
  const allWarnings = [
    ...(conservative?.warnings ?? []).map((w) => ({ mode: "conservative", ...w })),
    ...(conservative?.positionWarnings ?? []).map((w) => ({ mode: "conservative", level: "position", ...w })),
    ...(balanced?.warnings ?? []).map((w) => ({ mode: "balanced", ...w })),
    ...(balanced?.positionWarnings ?? []).map((w) => ({ mode: "balanced", level: "position", ...w })),
    ...(aggressive?.warnings ?? []).map((w) => ({ mode: "aggressive", ...w })),
    ...(aggressive?.positionWarnings ?? []).map((w) => ({ mode: "aggressive", level: "position", ...w })),
    ...(comparison?.warnings ?? []).map((w) => ({ mode: "comparison", ...w })),
  ];

  return {
    auditVersion: AUDIT_VERSION,
    auditTimestamp: new Date().toISOString(),
    accountCapital: accountCapital > 0 ? accountCapital : null,
    modes: { conservative, balanced, aggressive },
    comparison,
    warnings: allWarnings,
    warningCount: allWarnings.length,
    highSeverityCount: allWarnings.filter((w) => w.severity === "HIGH").length,
    ok: allWarnings.length === 0,
    // Safety contract — immutable
    passive: true,
    appliedToScanner: false,
    appliedToRanking: false,
    appliedToEliteScore: false,
    noLiveFetch: true,
    noIbkrFetch: true,
    noYahooFetch: true,
  };
}
