import {
  BALANCED_EFFECTIVE_MAX_SPREAD_PCT,
  BALANCED_LEG_SOURCES,
  BALANCED_NATIVE_REASON_CODES,
  getAggressivePriorityGrade,
  getBalancedYieldBandStatus,
  getCanonicalPeriodYieldBand,
  getFinalDisplayRecommendation,
  getLegPeriodYieldPct,
  getLegSpreadPct,
  gradeLeg,
  isValidComboDte,
  resolveCapitalComboInspectorLegView,
  resolveLegDte,
} from "./capitalComboPortfolio.js";

export const DASHBOARD_MODE_FILTER_OPTIONS = Object.freeze([
  Object.freeze({ value: "all", label: "Mode: Tous" }),
  Object.freeze({ value: "SAFE", label: "Mode: SAFE" }),
  Object.freeze({ value: "BALANCED", label: "Mode: BALANCED" }),
  Object.freeze({ value: "AGGRESSIVE", label: "Mode: AGRESSIF" }),
]);

const COMBO_BUCKET_ALIASES = Object.freeze({
  SAFE: Object.freeze(["SAFE", "Conservateur"]),
  BALANCED: Object.freeze(["BALANCED", "Équilibré"]),
  AGGRESSIVE: Object.freeze(["AGGRESSIVE", "Agressif"]),
});

const BALANCED_AVAILABLE_SOURCES = new Set([
  BALANCED_LEG_SOURCES.NATIVE,
  BALANCED_LEG_SOURCES.FALLBACK_SAFE,
  BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
]);

const LEG_SOURCE_LABELS = Object.freeze({
  [BALANCED_LEG_SOURCES.NATIVE]: "Native",
  [BALANCED_LEG_SOURCES.FALLBACK_SAFE]: "Fallback SAFE",
  [BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE]: "Fallback AGRESSIF",
});

const PORTFOLIO_BADGE_LABELS = Object.freeze({
  SAFE: "Portefeuille SAFE",
  BALANCED: "Portefeuille BALANCED",
  AGGRESSIVE: "Portefeuille AGRESSIF",
});

/**
 * Codes de raison strictement natifs — jamais issus des fallbacks ni de la
 * décision finale. NO_BALANCED_FALLBACK_ELIGIBLE et FALLBACK_*_SELECTED ne
 * doivent jamais être présentés comme raison native.
 */
const BALANCED_NON_NATIVE_REASON_CODES = new Set([
  BALANCED_NATIVE_REASON_CODES.FALLBACK_SAFE,
  BALANCED_NATIVE_REASON_CODES.FALLBACK_AGGRESSIVE,
  BALANCED_NATIVE_REASON_CODES.NO_FALLBACK,
]);

function resolveNativeScopedReason(...values) {
  for (const value of values) {
    const text = stringOrNull(value);
    if (!text) continue;
    if (BALANCED_NON_NATIVE_REASON_CODES.has(text)) continue;
    return text;
  }
  return null;
}

function finiteOrNull(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
  }
  return null;
}

function stringOrNull(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function bucketLabelForMode(mode) {
  const normalized = String(mode || "").trim().toUpperCase();
  if (normalized === "AGGRESSIVE") return "AGRESSIF";
  if (normalized === "BALANCED") return "BALANCED";
  if (normalized === "SAFE") return "SAFE";
  if (normalized === "REJECT") return "REJECT";
  return normalized || null;
}

export function computeAnnualizedSimpleYieldPct(weeklyNormalizedYieldPct) {
  const weekly = finiteOrNull(weeklyNormalizedYieldPct);
  if (weekly == null || weekly <= 0) return null;
  const annualized = (weekly * 365) / 7;
  return Number.isFinite(annualized) && annualized >= 0 ? annualized : null;
}

export function formatAnnualizedSimpleYieldPct(annualizedSimpleYieldPct) {
  const value = finiteOrNull(annualizedSimpleYieldPct);
  if (value == null) return "n/d";
  return `${value.toFixed(1)}%`;
}

/**
 * Moyenne pondérée par le capital, excluant strictement les valeurs inconnues.
 *
 * Une valeur inconnue (`null` / `undefined` / chaîne vide) n'est JAMAIS comptée
 * comme 0 : elle est écartée du numérateur ET du dénominateur. Un 0 réel et fini
 * reste inclus (ex. distance 0 %). Retourne `null` si aucune ligne exploitable —
 * jamais 0 ni NaN.
 *
 * Exemple POP : [94, 94, 95, null] à capital égal ⇒ 94,3 % (et non 70,8 %).
 */
export function weightedMeanByCapitalExcludingUnknown(rows, valueOf, weightOf) {
  let sumWx = 0;
  let sumW = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawValue = valueOf(row);
    // Garde explicite : inconnue reste inconnue (jamais 0 par conversion).
    if (rawValue == null || rawValue === "") continue;
    const x = Number(rawValue);
    const w = Number(weightOf(row));
    if (!Number.isFinite(x) || !Number.isFinite(w) || w <= 0) continue;
    sumWx += x * w;
    sumW += w;
  }
  return sumW > 0 ? sumWx / sumW : null;
}

function resolveBalancedBucketContext(row) {
  const balancedVm = row?.balancedCardViewModel ?? null;
  const balancedSource = stringOrNull(
    balancedVm?.source,
    row?.balancedLegSource,
    row?.capitalComboBalancedLegSource,
  )?.toUpperCase();
  const balancedAvailable =
    balancedVm?.available === true || BALANCED_AVAILABLE_SOURCES.has(balancedSource);
  return {
    balancedVm,
    balancedSource: balancedAvailable ? balancedSource : null,
    balancedAvailable,
  };
}

function resolveUnderlyingLegMode(source) {
  if (source === BALANCED_LEG_SOURCES.FALLBACK_SAFE) return "SAFE";
  if (source === BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE) return "AGGRESSIVE";
  if (source === BALANCED_LEG_SOURCES.NATIVE) return "BALANCED";
  return null;
}

/**
 * Projection pure des quatre concepts indépendants :
 * - recommandation du scan (contour vert, badge principal) ;
 * - appartenances aux portefeuilles SAFE/BALANCED/AGGRESSIVE (informations
 *   secondaires uniquement, jamais le contour).
 * Cas A confirmé par audit : getFinalDisplayRecommendation ne retourne que
 * SAFE, AGGRESSIVE ou REJECT — la recommandation canonique du scan ne vaut
 * jamais BALANCED, donc isBalancedScanRecommended est toujours false.
 */
export function resolveScanRecommendationSemantics(row) {
  const recommendation = getFinalDisplayRecommendation(row);
  const scanRecommendationMode = recommendation.finalDisplayMode;
  const isInSafePortfolio = row?.selectedForSafe === true;
  const isInBalancedPortfolio = row?.selectedForBalanced === true;
  const isInAggressivePortfolio = row?.selectedForAggressive === true;
  return {
    scanRecommendationMode,
    scanRecommendationGrade: recommendation.finalDisplayGrade,
    isSafeScanRecommended: scanRecommendationMode === "SAFE",
    isAggressiveScanRecommended: scanRecommendationMode === "AGGRESSIVE",
    isBalancedScanRecommended: false,
    isInSafePortfolio,
    isInBalancedPortfolio,
    isInAggressivePortfolio,
    portfolioMembershipLabels: [
      ...(isInSafePortfolio ? ["SAFE"] : []),
      ...(isInBalancedPortfolio ? ["BALANCED"] : []),
      ...(isInAggressivePortfolio ? ["AGRESSIF"] : []),
    ],
  };
}

/**
 * Grade réellement porté par la jambe SAFE affichée. Si le scan recommande
 * SAFE, le grade canonique est finalDisplayGrade (calculé sur cette même
 * jambe) ; sinon on lit le grade de la jambe elle-même, dérivé en dernier
 * recours des métriques de cette jambe — jamais d'une autre jambe.
 */
export function resolveSafeLegDisplayGrade(row, recommendation = null) {
  if (!recommendation) recommendation = getFinalDisplayRecommendation(row);
  if (recommendation?.finalDisplayMode === "SAFE") return recommendation.finalDisplayGrade;
  const diag = row?.recommendationDiagnostics ?? null;
  const explicit = stringOrNull(row?.safeGrade, diag?.safeGrade)?.toUpperCase();
  if (explicit) return explicit;
  const leg = row?.safeStrike ?? null;
  if (!leg) return null;
  return gradeLeg({
    spreadPct: leg?.liquidity?.spreadPct ?? leg?.spreadPct ?? diag?.safeSpreadPct ?? null,
    weeklyYieldPct: leg?.weeklyYield ?? diag?.safeYieldPct ?? null,
    popDecimal: leg?.popProfitEstimated ?? leg?.popEstimate ?? null,
  });
}

/**
 * Grade réellement porté par la jambe AGGRESSIVE affichée — même résolution
 * effective que getFinalDisplayRecommendation (priorityGrade ?? grade brut),
 * pour que le classement ne mélange jamais mode effectif et grade brut
 * (cause du « AGRESSIF REJET » incohérent).
 */
export function resolveAggressiveLegDisplayGrade(row, recommendation = null) {
  if (!recommendation) recommendation = getFinalDisplayRecommendation(row);
  if (recommendation?.finalDisplayMode === "AGGRESSIVE") return recommendation.finalDisplayGrade;
  const diag = row?.recommendationDiagnostics ?? null;
  const leg = row?.aggressiveStrike ?? null;
  const priorityGrade = getAggressivePriorityGrade({
    spreadPct:
      leg?.liquidity?.spreadPct ??
      leg?.spreadPct ??
      diag?.aggressiveSpreadPctDisplay ??
      diag?.aggressiveSpreadPct ??
      null,
    weeklyYieldPct: leg?.weeklyYield ?? diag?.aggressiveYieldPct ?? null,
    popDecimal: leg?.popProfitEstimated ?? leg?.popEstimate ?? diag?.aggressivePop ?? null,
    distancePct:
      leg?.distancePct ?? diag?.aggressiveDistancePctDisplay ?? diag?.aggressiveDistancePct ?? null,
  });
  if (priorityGrade) return priorityGrade;
  const explicit = stringOrNull(row?.aggressiveGrade, diag?.aggressiveGrade)?.toUpperCase();
  if (explicit) return explicit;
  if (!leg) return null;
  return gradeLeg({
    spreadPct: leg?.liquidity?.spreadPct ?? leg?.spreadPct ?? null,
    weeklyYieldPct: leg?.weeklyYield ?? null,
    popDecimal: leg?.popProfitEstimated ?? leg?.popEstimate ?? null,
  });
}

function resolveLegDisplayFinancials(leg) {
  const popDecimal = finiteOrNull(leg?.popProfitEstimated ?? leg?.popEstimate);
  return {
    strike: finiteOrNull(leg?.strike),
    premium: finiteOrNull(leg?.premiumUsed ?? leg?.mid ?? leg?.premium ?? leg?.bid),
    periodYieldPct: finiteOrNull(leg?.weeklyYield),
    weeklyNormalizedYieldPct: finiteOrNull(leg?.weeklyNormalizedYield),
    spreadPct: finiteOrNull(leg?.liquidity?.spreadPct ?? leg?.spreadPct),
    distancePct: finiteOrNull(leg?.distancePct),
    popPct: popDecimal == null ? null : popDecimal <= 1 ? popDecimal * 100 : popDecimal,
  };
}

function finalizeModePresentation(base, { scannerMode, scannerGrade, modeFilter }) {
  const isScanRecommended =
    (base.bucketMode === "SAFE" || base.bucketMode === "AGGRESSIVE") &&
    base.bucketMode === scannerMode;
  return {
    ...base,
    mode: base.bucketMode,
    modeLabel: base.bucketLabel,
    leg: base.displayLeg,
    status:
      base.displayLeg == null || base.bucketMode === "REJECT"
        ? "unavailable"
        : isScanRecommended
          ? "recommended"
          : "available",
    isScanRecommended,
    scanRecommendationMode: scannerMode,
    scanRecommendationGrade: scannerGrade,
    recommendationSource: modeFilter === "all" ? "scan" : "modeFilter",
    ...resolveLegDisplayFinancials(base.displayLeg),
  };
}

/**
 * Jambe canonique affichée dans une ligne du classement : mode, libellé,
 * grade, strike, prime, rendement, spread, distance et POP proviennent tous
 * du même objet jambe (displayLeg). Aucun mélange de sources.
 */
export function resolveDashboardModePresentation(row, { modeFilter = "all" } = {}) {
  const { balancedVm, balancedSource, balancedAvailable } = resolveBalancedBucketContext(row);
  const recommendation = getFinalDisplayRecommendation(row);
  const scannerMode = recommendation.finalDisplayMode;
  const scannerGrade = recommendation.finalDisplayGrade;
  const context = { scannerMode, scannerGrade, modeFilter };

  if (balancedAvailable && modeFilter === "BALANCED") {
    const legSourceLabel = LEG_SOURCE_LABELS[balancedSource] ?? balancedVm?.sourceLabel ?? null;
    return finalizeModePresentation(
      {
        bucketMode: "BALANCED",
        bucketLabel: "BALANCED",
        grade: stringOrNull(balancedVm?.grade, row?.balancedGrade),
        legSource: balancedSource,
        legSourceLabel,
        underlyingLegMode: resolveUnderlyingLegMode(balancedSource),
        filterMode: "BALANCED",
        displayLeg:
          balancedVm?.strike != null
            ? {
                strike: balancedVm.strike,
                bid: balancedVm.bid,
                premiumUsed: balancedVm.premium,
                weeklyYield: balancedVm.periodYieldPct,
                weeklyNormalizedYield: balancedVm.weeklyNormalizedYieldPct,
                liquidity: { spreadPct: balancedVm.spreadPct },
                distancePct: balancedVm.distancePct,
                popProfitEstimated: balancedVm.popDecimal,
              }
            : null,
      },
      context,
    );
  }

  if (modeFilter === "SAFE" || (modeFilter === "all" && scannerMode === "SAFE")) {
    return finalizeModePresentation(
      {
        bucketMode: "SAFE",
        bucketLabel: "SAFE",
        grade: resolveSafeLegDisplayGrade(row, recommendation),
        legSource: null,
        legSourceLabel: null,
        underlyingLegMode: "SAFE",
        filterMode: "SAFE",
        displayLeg: row?.safeStrike ?? null,
      },
      context,
    );
  }

  if (modeFilter === "AGGRESSIVE" || (modeFilter === "all" && scannerMode === "AGGRESSIVE")) {
    return finalizeModePresentation(
      {
        bucketMode: "AGGRESSIVE",
        bucketLabel: "AGRESSIF",
        grade: resolveAggressiveLegDisplayGrade(row, recommendation),
        legSource: null,
        legSourceLabel: null,
        underlyingLegMode: "AGGRESSIVE",
        filterMode: "AGGRESSIVE",
        displayLeg: row?.aggressiveStrike ?? null,
      },
      context,
    );
  }

  if (scannerMode === "REJECT") {
    return finalizeModePresentation(
      {
        bucketMode: "REJECT",
        bucketLabel: "REJECT",
        grade: scannerGrade,
        legSource: null,
        legSourceLabel: null,
        underlyingLegMode: null,
        filterMode: null,
        displayLeg: row?.safeStrike ?? row?.aggressiveStrike ?? null,
      },
      context,
    );
  }

  return finalizeModePresentation(
    {
      bucketMode: scannerMode,
      bucketLabel: bucketLabelForMode(scannerMode),
      grade: scannerGrade,
      legSource: null,
      legSourceLabel: null,
      underlyingLegMode: scannerMode,
      filterMode: scannerMode,
      displayLeg: scannerMode === "AGGRESSIVE" ? row?.aggressiveStrike ?? null : row?.safeStrike ?? null,
    },
    context,
  );
}

export function resolveDashboardModeForFilter(item) {
  const { balancedAvailable } = resolveBalancedBucketContext(item);
  if (balancedAvailable) return "BALANCED";

  const explicitMode = stringOrNull(item?.capitalComboBucketMode, item?.bucketMode)?.toUpperCase();
  if (explicitMode === "SAFE" || explicitMode === "AGGRESSIVE") return explicitMode;
  return getFinalDisplayRecommendation(item)?.finalDisplayMode ?? null;
}

export function resolvePortfolioSelectionByTicker(combos = []) {
  const map = new Map();
  for (const [bucketKey, aliases] of Object.entries(COMBO_BUCKET_ALIASES)) {
    const combo = (Array.isArray(combos) ? combos : []).find((row) => aliases.includes(row?.label));
    const picks = Array.isArray(combo?.picks) ? combo.picks : [];
    for (const pick of picks) {
      const ticker = String(pick?.ticker || "").trim().toUpperCase();
      if (!ticker) continue;
      if (!map.has(ticker)) {
        map.set(ticker, {
          selectedForSafe: false,
          selectedForBalanced: false,
          selectedForAggressive: false,
        });
      }
      const entry = map.get(ticker);
      if (bucketKey === "SAFE") entry.selectedForSafe = true;
      if (bucketKey === "BALANCED") entry.selectedForBalanced = true;
      if (bucketKey === "AGGRESSIVE") entry.selectedForAggressive = true;
    }
  }
  return map;
}

function describeFallbackRejection(modeLabel, leg, candidate, band) {
  if (!leg) {
    return `${modeLabel} fallback rejeté : jambe absente`;
  }
  const periodYieldPct = getLegPeriodYieldPct(leg, candidate);
  const spreadPct = getLegSpreadPct(leg);
  if (periodYieldPct == null) {
    return `${modeLabel} fallback rejeté : données de rendement indisponibles`;
  }
  if (!Number.isFinite(spreadPct) || spreadPct < 0) {
    return `${modeLabel} fallback rejeté : spread indisponible ou invalide`;
  }
  if (spreadPct > BALANCED_EFFECTIVE_MAX_SPREAD_PCT) {
    return `${modeLabel} fallback rejeté : spread ${spreadPct.toFixed(2)} % > ${BALANCED_EFFECTIVE_MAX_SPREAD_PCT} %`;
  }
  const yieldBandStatus = getBalancedYieldBandStatus(periodYieldPct, band);
  return `${modeLabel} fallback rejeté : filtre d'exécution ou de qualité (statut rendement ${yieldBandStatus ?? "n/d"})`;
}

export function buildBalancedUnavailableDiagnostics({
  candidate,
  diagnostics = null,
  legView = null,
} = {}) {
  const safeLeg = candidate?.safeStrike ?? null;
  const aggressiveLeg = candidate?.aggressiveStrike ?? null;
  const safeStrike = finiteOrNull(diagnostics?.safeStrike, safeLeg?.strike);
  const aggressiveStrike = finiteOrNull(diagnostics?.aggressiveStrike, aggressiveLeg?.strike);
  const midpointStrike = finiteOrNull(diagnostics?.midpointStrike);
  const dteDays = finiteOrNull(diagnostics?.dteDays, candidate?.dteDays);
  const band =
    diagnostics?.effectivePeriodMinPct != null
      ? {
          effectivePeriodMinPct: diagnostics.effectivePeriodMinPct,
          effectivePeriodMaxPct: diagnostics.effectivePeriodMaxPct,
        }
      : isValidComboDte(dteDays)
        ? getCanonicalPeriodYieldBand("BALANCED", dteDays)
        : null;
  const safePeriodYieldPct = safeLeg ? getLegPeriodYieldPct(safeLeg, candidate) : null;
  const aggressivePeriodYieldPct = aggressiveLeg ? getLegPeriodYieldPct(aggressiveLeg, candidate) : null;
  // Raison native strictement scoped : jamais NO_BALANCED_FALLBACK_ELIGIBLE
  // ni FALLBACK_*_SELECTED (ce sont des raisons de fallback/finale).
  const nativePrimaryReason = resolveNativeScopedReason(
    diagnostics?.diagnostics?.nativePrimaryReason,
    diagnostics?.primaryReason,
    diagnostics?.reasonCode,
  );
  const finalReason = stringOrNull(
    diagnostics?.primaryReason,
    diagnostics?.reasonCode,
    legView?.selectionReason,
  );
  const reasonCodes = Array.isArray(diagnostics?.reasonCodes) ? diagnostics.reasonCodes : [];
  const safeFallbackRejection = describeFallbackRejection("SAFE", safeLeg, candidate, band);
  const aggressiveFallbackRejection = describeFallbackRejection("AGRESSIF", aggressiveLeg, candidate, band);

  return {
    safeStrike,
    aggressiveStrike,
    midpointStrike,
    safePeriodYieldPct,
    aggressivePeriodYieldPct,
    effectivePeriodMinPct: band?.effectivePeriodMinPct ?? null,
    effectivePeriodMaxPct: band?.effectivePeriodMaxPct ?? null,
    intermediateContractCount: finiteOrNull(diagnostics?.intermediateContractCount),
    quoteValidIntermediateCount: finiteOrNull(diagnostics?.quoteValidIntermediateCount),
    yieldEligibleIntermediateCount: finiteOrNull(diagnostics?.yieldEligibleIntermediateCount),
    spreadEligibleIntermediateCount: finiteOrNull(diagnostics?.spreadEligibleIntermediateCount),
    liquidityEligibleIntermediateCount: finiteOrNull(diagnostics?.liquidityEligibleIntermediateCount),
    fullyEligibleIntermediateCount: finiteOrNull(diagnostics?.fullyEligibleIntermediateCount),
    executionEligibleIntermediateCount: finiteOrNull(diagnostics?.executionEligibleIntermediateCount),
    nativePrimaryReason,
    finalReason,
    reasonCodes,
    safeFallbackRejection,
    aggressiveFallbackRejection,
    // Projection structurée : la raison native, les raisons de fallback et la
    // raison finale sont trois niveaux distincts, jamais interchangeables.
    native: {
      status: "unavailable",
      primaryReason: nativePrimaryReason,
      intermediateContractCount: finiteOrNull(diagnostics?.intermediateContractCount),
      quoteValidIntermediateCount: finiteOrNull(diagnostics?.quoteValidIntermediateCount),
      yieldEligibleIntermediateCount: finiteOrNull(diagnostics?.yieldEligibleIntermediateCount),
      spreadEligibleIntermediateCount: finiteOrNull(diagnostics?.spreadEligibleIntermediateCount),
      liquidityEligibleIntermediateCount: finiteOrNull(diagnostics?.liquidityEligibleIntermediateCount),
      fullyEligibleIntermediateCount: finiteOrNull(diagnostics?.fullyEligibleIntermediateCount),
      executionEligibleIntermediateCount: finiteOrNull(diagnostics?.executionEligibleIntermediateCount),
    },
    fallbackSafe: {
      status: safeLeg ? "rejected" : "absent",
      reason: safeFallbackRejection,
      periodYieldPct: safePeriodYieldPct,
      effectiveMinPct: band?.effectivePeriodMinPct ?? null,
      effectiveMaxPct: band?.effectivePeriodMaxPct ?? null,
    },
    fallbackAggressive: {
      status: aggressiveLeg ? "rejected" : "absent",
      reason: aggressiveFallbackRejection,
      periodYieldPct: aggressivePeriodYieldPct,
      effectiveMinPct: band?.effectivePeriodMinPct ?? null,
      effectiveMaxPct: band?.effectivePeriodMaxPct ?? null,
    },
    final: {
      source: BALANCED_LEG_SOURCES.UNAVAILABLE,
      status: "unavailable",
      reason: finalReason,
    },
    midpointStrikeNote:
      midpointStrike != null
        ? `Milieu ${midpointStrike}`
        : safeStrike != null && aggressiveStrike != null
          ? `Milieu ${(safeStrike + aggressiveStrike) / 2}`
          : null,
  };
}

export function enrichCandidateRowForDisplay(item, portfolioSelection = new Map()) {
  const ticker = String(item?.ticker || "").trim().toUpperCase();
  const selection = portfolioSelection.get(ticker) ?? {
    selectedForSafe: false,
    selectedForBalanced: false,
    selectedForAggressive: false,
  };
  const balancedSource = stringOrNull(item?.balancedCardViewModel?.source, item?.balancedLegSource);
  const balancedCardViewModel = item?.balancedCardViewModel
    ? {
        ...item.balancedCardViewModel,
        selectedForBalanced: selection.selectedForBalanced,
        selectedByOptimizer: selection.selectedForBalanced,
        notSelectedReason: selection.selectedForBalanced
          ? null
          : item.balancedCardViewModel.notSelectedReason,
        badgeLabel: selection.selectedForBalanced
          ? PORTFOLIO_BADGE_LABELS.BALANCED
          : null,
      }
    : item?.balancedCardViewModel ?? null;

  return {
    ...item,
    selectedForSafe: selection.selectedForSafe,
    selectedForBalanced: selection.selectedForBalanced,
    selectedForAggressive: selection.selectedForAggressive,
    balancedLegSource: balancedSource,
    capitalComboBucketMode:
      item?.capitalComboBucketMode ??
      (balancedCardViewModel?.available ? "BALANCED" : null),
    balancedCardViewModel,
  };
}

export function resolveBalancedCardViewModel({
  candidate,
  pick = null,
  usableCapital = 100000,
  portfolioSelection = null,
} = {}) {
  const legView = resolveCapitalComboInspectorLegView({
    bucketKey: "BALANCED",
    candidate,
    pick,
    usableCapital,
  });
  const diagnostics = legView?.balancedLegDiagnostics ?? null;
  const selectedLeg = legView?.selectedLeg ?? diagnostics?.selectedLeg ?? null;
  const source =
    stringOrNull(legView?.balancedLegSource, diagnostics?.source) ??
    BALANCED_LEG_SOURCES.UNAVAILABLE;
  const available =
    legView?.bucketLegAvailable === true &&
    BALANCED_AVAILABLE_SOURCES.has(source) &&
    selectedLeg != null;
  const legSourceLabel = LEG_SOURCE_LABELS[source] ?? "BALANCED indisponible";
  const strike = finiteOrNull(legView?.selectedStrike ?? selectedLeg?.strike);
  const periodYieldPct = finiteOrNull(
    legView?.selectedPeriodYieldPct ?? diagnostics?.selectedPeriodYieldPct,
    selectedLeg ? getLegPeriodYieldPct(selectedLeg, candidate) : null,
  );
  const weeklyNormalizedYieldPct = finiteOrNull(
    legView?.selectedWeeklyYieldPct,
    diagnostics?.selectedWeeklyNormalizedYieldPct,
    selectedLeg?.weeklyNormalizedYield,
  );
  const popDecimal = finiteOrNull(
    selectedLeg?.popProfitEstimated ?? selectedLeg?.popEstimate,
  );
  const explicitCapitalRequired = finiteOrNull(
    selectedLeg?.capitalRequired ?? pick?.capitalRequired,
  );
  const capitalRequired =
    explicitCapitalRequired ?? (strike != null && strike > 0 ? strike * 100 : null);
  const resolvedDteDays = finiteOrNull(
    diagnostics?.dteDays ?? selectedLeg?.dteDays,
    resolveLegDte(selectedLeg, candidate),
  );
  const yieldBand =
    diagnostics?.effectivePeriodMinPct != null
      ? {
          effectivePeriodMinPct: diagnostics.effectivePeriodMinPct,
          effectivePeriodMaxPct: diagnostics.effectivePeriodMaxPct,
        }
      : isValidComboDte(resolvedDteDays)
        ? getCanonicalPeriodYieldBand("BALANCED", resolvedDteDays)
        : null;
  const yieldBandStatus =
    stringOrNull(diagnostics?.selectedYieldBandStatus, diagnostics?.yieldBandStatus) ??
    getBalancedYieldBandStatus(periodYieldPct, yieldBand);
  const engineAnnualized = finiteOrNull(selectedLeg?.annualizedYield);
  const annualizedSimpleYieldPct =
    engineAnnualized != null && engineAnnualized > 0 && engineAnnualized <= 5
      ? engineAnnualized * 100
      : engineAnnualized ?? computeAnnualizedSimpleYieldPct(weeklyNormalizedYieldPct);

  const ticker = String(candidate?.ticker || "").trim().toUpperCase();
  const selection =
    portfolioSelection?.get?.(ticker) ??
    (portfolioSelection && typeof portfolioSelection === "object" && "selectedForBalanced" in portfolioSelection
      ? portfolioSelection
      : null);
  const selectedForBalanced = selection?.selectedForBalanced === true;
  const executionEligible =
    available &&
    diagnostics?.selectedExecutionEligible !== false &&
    diagnostics?.executionEligible !== false;
  const capitalFitsBalancedPool =
    capitalRequired != null && capitalRequired > 0 && capitalRequired <= usableCapital;
  const includedInBalancedPool =
    available &&
    diagnostics?.includedInBalancedPool !== false &&
    capitalFitsBalancedPool;
  const notSelectedReason = !available || selectedForBalanced
    ? null
    : !capitalFitsBalancedPool
      ? "CAPITAL_INSUFFICIENT"
      : "GREEDY_NOT_SELECTED";

  const unavailableDiagnostics = available
    ? null
    : buildBalancedUnavailableDiagnostics({ candidate, diagnostics, legView });

  return {
    available,
    source,
    sourceLabel: available ? legSourceLabel : "BALANCED indisponible",
    badgeLabel: selectedForBalanced ? PORTFOLIO_BADGE_LABELS.BALANCED : null,
    mode: "BALANCED",
    grade: stringOrNull(legView?.selectedGrade, diagnostics?.selectedGrade, selectedLeg?.grade),
    strike,
    premium: finiteOrNull(
      selectedLeg?.premiumUsed ??
        selectedLeg?.primeUsed ??
        selectedLeg?.conservativePremium ??
        selectedLeg?.premium,
    ),
    bid: finiteOrNull(selectedLeg?.bid),
    ask: finiteOrNull(selectedLeg?.ask),
    mid: finiteOrNull(selectedLeg?.mid),
    spreadPct: finiteOrNull(
      legView?.selectedSpreadPct ??
        diagnostics?.selectedSpreadPct ??
        selectedLeg?.liquidity?.spreadPct ??
        selectedLeg?.spreadPct,
    ),
    periodYieldPct,
    yieldBandStatus,
    executionEligible,
    includedInBalancedPool,
    selectedByOptimizer: selectedForBalanced,
    notSelectedReason,
    weeklyNormalizedYieldPct,
    annualizedSimpleYieldPct,
    distancePct: finiteOrNull(selectedLeg?.distancePct),
    popPct: popDecimal == null ? null : popDecimal * 100,
    popDecimal,
    dteDays: resolvedDteDays,
    expiration: stringOrNull(selectedLeg?.expiration, candidate?.targetExpiration, candidate?.expiration),
    optionSymbol: stringOrNull(selectedLeg?.optionSymbol, selectedLeg?.contractSymbol),
    conId: finiteOrNull(selectedLeg?.conId),
    contractId: finiteOrNull(selectedLeg?.contractId ?? selectedLeg?.conId),
    quoteTimestamp: stringOrNull(selectedLeg?.quoteTimestamp),
    marketDataType: stringOrNull(selectedLeg?.marketDataType),
    quoteSource: stringOrNull(selectedLeg?.quoteSource, selectedLeg?.source),
    capitalRequired,
    safeStrike: finiteOrNull(diagnostics?.safeStrike, candidate?.safeStrike?.strike),
    aggressiveStrike: finiteOrNull(diagnostics?.aggressiveStrike, candidate?.aggressiveStrike?.strike),
    midpointStrike: finiteOrNull(diagnostics?.midpointStrike),
    effectivePeriodMinPct: finiteOrNull(diagnostics?.effectivePeriodMinPct),
    effectivePeriodMaxPct: finiteOrNull(diagnostics?.effectivePeriodMaxPct),
    // Raison finale (source retenue ou NO_BALANCED_FALLBACK_ELIGIBLE) — jamais
    // confondue avec la raison native, exposée séparément ci-dessous.
    primaryReason: stringOrNull(
      diagnostics?.primaryReason,
      diagnostics?.reasonCode,
      legView?.selectionReason,
    ),
    nativePrimaryReason: resolveNativeScopedReason(
      diagnostics?.diagnostics?.nativePrimaryReason,
      diagnostics?.primaryReason,
      diagnostics?.reasonCode,
    ),
    finalReason: stringOrNull(
      diagnostics?.primaryReason,
      diagnostics?.reasonCode,
      legView?.selectionReason,
    ),
    unavailableDiagnostics,
    selectedForBalanced,
    diagnostics,
  };
}
