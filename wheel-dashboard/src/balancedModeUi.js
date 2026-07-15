import {
  BALANCED_LEG_SOURCES,
  getCanonicalPeriodYieldBand,
  getFinalDisplayRecommendation,
  getLegPeriodYieldPct,
  getLegSpreadPct,
  isPeriodYieldAdmissibleInBand,
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
  SAFE: "Sélectionné dans SAFE",
  BALANCED: "Sélectionné dans BALANCED",
  AGGRESSIVE: "Sélectionné dans AGRESSIF",
});

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

export function resolveDashboardModePresentation(row, { modeFilter = "all" } = {}) {
  const { balancedVm, balancedSource, balancedAvailable } = resolveBalancedBucketContext(row);
  const recommendation = getFinalDisplayRecommendation(row);
  const scannerMode = recommendation.finalDisplayMode;
  const scannerGrade = recommendation.finalDisplayGrade;

  if (balancedAvailable && modeFilter === "BALANCED") {
    const legSourceLabel = LEG_SOURCE_LABELS[balancedSource] ?? balancedVm?.sourceLabel ?? null;
    return {
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
              weeklyYield: balancedVm.periodYieldPct,
              weeklyNormalizedYield: balancedVm.weeklyNormalizedYieldPct,
              liquidity: { spreadPct: balancedVm.spreadPct },
              distancePct: balancedVm.distancePct,
              popProfitEstimated: balancedVm.popDecimal,
            }
          : null,
    };
  }

  if (modeFilter === "SAFE" || (modeFilter === "all" && scannerMode === "SAFE")) {
    return {
      bucketMode: "SAFE",
      bucketLabel: "SAFE",
      grade: stringOrNull(row?.safeGrade, scannerGrade),
      legSource: null,
      legSourceLabel: null,
      underlyingLegMode: "SAFE",
      filterMode: "SAFE",
      displayLeg: row?.safeStrike ?? null,
    };
  }

  if (modeFilter === "AGGRESSIVE" || (modeFilter === "all" && scannerMode === "AGGRESSIVE")) {
    return {
      bucketMode: "AGGRESSIVE",
      bucketLabel: "AGRESSIF",
      grade: stringOrNull(row?.aggressiveGrade, scannerGrade),
      legSource: null,
      legSourceLabel: null,
      underlyingLegMode: "AGGRESSIVE",
      filterMode: "AGGRESSIVE",
      displayLeg: row?.aggressiveStrike ?? null,
    };
  }

  if (scannerMode === "REJECT") {
    return {
      bucketMode: "REJECT",
      bucketLabel: "REJECT",
      grade: scannerGrade,
      legSource: null,
      legSourceLabel: null,
      underlyingLegMode: null,
      filterMode: null,
      displayLeg: row?.safeStrike ?? row?.aggressiveStrike ?? null,
    };
  }

  return {
    bucketMode: scannerMode,
    bucketLabel: bucketLabelForMode(scannerMode),
    grade: scannerGrade,
    legSource: null,
    legSourceLabel: null,
    underlyingLegMode: scannerMode,
    filterMode: scannerMode,
    displayLeg: scannerMode === "AGGRESSIVE" ? row?.aggressiveStrike ?? null : row?.safeStrike ?? null,
  };
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
    return `${modeLabel} fallback rejeté : rendement indisponible`;
  }
  if (band?.effectivePeriodMinPct != null && periodYieldPct < band.effectivePeriodMinPct) {
    return `${modeLabel} fallback rejeté : rendement ${periodYieldPct.toFixed(2)} % < minimum BALANCED ${band.effectivePeriodMinPct.toFixed(2)} %`;
  }
  if (band?.effectivePeriodMaxPct != null && periodYieldPct >= band.effectivePeriodMaxPct) {
    return `${modeLabel} fallback rejeté : rendement ${periodYieldPct.toFixed(2)} % ≥ maximum BALANCED exclusif ${band.effectivePeriodMaxPct.toFixed(2)} %`;
  }
  if (spreadPct != null && spreadPct > 20) {
    return `${modeLabel} fallback rejeté : spread ${spreadPct.toFixed(2)} % > 20 %`;
  }
  if (!isPeriodYieldAdmissibleInBand(periodYieldPct, band)) {
    return `${modeLabel} fallback rejeté : rendement ${periodYieldPct.toFixed(2)} % hors bande BALANCED`;
  }
  return `${modeLabel} fallback rejeté : filtre statique`;
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
  const nativePrimaryReason = stringOrNull(
    diagnostics?.diagnostics?.nativePrimaryReason,
    diagnostics?.primaryReason,
    legView?.selectionReason,
  );
  const reasonCodes = Array.isArray(diagnostics?.reasonCodes) ? diagnostics.reasonCodes : [];

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
    fullyEligibleIntermediateCount: finiteOrNull(diagnostics?.fullyEligibleIntermediateCount),
    nativePrimaryReason,
    reasonCodes,
    safeFallbackRejection: describeFallbackRejection("SAFE", safeLeg, candidate, band),
    aggressiveFallbackRejection: describeFallbackRejection("AGRESSIF", aggressiveLeg, candidate, band),
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
    weeklyNormalizedYieldPct,
    annualizedSimpleYieldPct,
    distancePct: finiteOrNull(selectedLeg?.distancePct),
    popPct: popDecimal == null ? null : popDecimal * 100,
    popDecimal,
    dteDays: finiteOrNull(diagnostics?.dteDays ?? selectedLeg?.dteDays, resolveLegDte(selectedLeg, candidate)),
    expiration: stringOrNull(selectedLeg?.expiration, candidate?.targetExpiration, candidate?.expiration),
    optionSymbol: stringOrNull(selectedLeg?.optionSymbol, selectedLeg?.contractSymbol),
    conId: finiteOrNull(selectedLeg?.conId),
    contractId: finiteOrNull(selectedLeg?.contractId ?? selectedLeg?.conId),
    quoteTimestamp: stringOrNull(selectedLeg?.quoteTimestamp),
    marketDataType: stringOrNull(selectedLeg?.marketDataType),
    quoteSource: stringOrNull(selectedLeg?.quoteSource, selectedLeg?.source),
    capitalRequired:
      explicitCapitalRequired ?? (strike != null && strike > 0 ? strike * 100 : null),
    safeStrike: finiteOrNull(diagnostics?.safeStrike, candidate?.safeStrike?.strike),
    aggressiveStrike: finiteOrNull(diagnostics?.aggressiveStrike, candidate?.aggressiveStrike?.strike),
    midpointStrike: finiteOrNull(diagnostics?.midpointStrike),
    effectivePeriodMinPct: finiteOrNull(diagnostics?.effectivePeriodMinPct),
    effectivePeriodMaxPct: finiteOrNull(diagnostics?.effectivePeriodMaxPct),
    primaryReason: stringOrNull(
      diagnostics?.diagnostics?.nativePrimaryReason,
      diagnostics?.primaryReason,
      diagnostics?.reasonCode,
      legView?.selectionReason,
    ),
    unavailableDiagnostics,
    selectedForBalanced,
    diagnostics,
  };
}
