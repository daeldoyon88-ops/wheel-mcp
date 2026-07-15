import {
  BALANCED_LEG_SOURCES,
  getFinalDisplayRecommendation,
  resolveCapitalComboInspectorLegView,
} from "./capitalComboPortfolio.js";

export const DASHBOARD_MODE_FILTER_OPTIONS = Object.freeze([
  Object.freeze({ value: "all", label: "Mode: Tous" }),
  Object.freeze({ value: "SAFE", label: "Mode: SAFE" }),
  Object.freeze({ value: "BALANCED", label: "Mode: BALANCED" }),
  Object.freeze({ value: "AGGRESSIVE", label: "Mode: AGRESSIF" }),
]);

const BALANCED_AVAILABLE_SOURCES = new Set([
  BALANCED_LEG_SOURCES.NATIVE,
  BALANCED_LEG_SOURCES.FALLBACK_SAFE,
  BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
]);

function finiteOrNull(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function stringOrNull(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function resolveSourceLabels(source) {
  if (source === BALANCED_LEG_SOURCES.NATIVE) {
    return {
      sourceLabel: "BALANCED native",
      badgeLabel: "Sélectionné BALANCED",
    };
  }
  if (source === BALANCED_LEG_SOURCES.FALLBACK_SAFE) {
    return {
      sourceLabel: "Fallback SAFE",
      badgeLabel: "BALANCED fallback",
    };
  }
  if (source === BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE) {
    return {
      sourceLabel: "Fallback AGGRESSIVE",
      badgeLabel: "BALANCED fallback",
    };
  }
  return {
    sourceLabel: "BALANCED indisponible",
    badgeLabel: null,
  };
}

export function resolveBalancedCardViewModel({
  candidate,
  pick = null,
  usableCapital = 100000,
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
  const labels = resolveSourceLabels(source);
  const strike = finiteOrNull(legView?.selectedStrike ?? selectedLeg?.strike);
  const periodYieldPct = finiteOrNull(
    legView?.selectedPeriodYieldPct ?? diagnostics?.selectedPeriodYieldPct,
  );
  const weeklyNormalizedYieldPct = finiteOrNull(
    legView?.selectedWeeklyYieldPct ?? diagnostics?.selectedWeeklyNormalizedYieldPct,
  );
  const popDecimal = finiteOrNull(
    selectedLeg?.popProfitEstimated ?? selectedLeg?.popEstimate,
  );
  const explicitCapitalRequired = finiteOrNull(
    selectedLeg?.capitalRequired ?? pick?.capitalRequired,
  );

  return {
    available,
    source,
    sourceLabel: labels.sourceLabel,
    badgeLabel: labels.badgeLabel,
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
    annualizedSimpleYieldPct: finiteOrNull(selectedLeg?.annualizedYield),
    distancePct: finiteOrNull(selectedLeg?.distancePct),
    popPct: popDecimal == null ? null : popDecimal * 100,
    popDecimal,
    dteDays: finiteOrNull(diagnostics?.dteDays ?? selectedLeg?.dteDays),
    expiration: stringOrNull(selectedLeg?.expiration, candidate?.targetExpiration, candidate?.expiration),
    optionSymbol: stringOrNull(selectedLeg?.optionSymbol, selectedLeg?.contractSymbol),
    conId: finiteOrNull(selectedLeg?.conId),
    contractId: finiteOrNull(selectedLeg?.contractId ?? selectedLeg?.conId),
    quoteTimestamp: stringOrNull(selectedLeg?.quoteTimestamp),
    marketDataType: stringOrNull(selectedLeg?.marketDataType),
    quoteSource: stringOrNull(selectedLeg?.quoteSource, selectedLeg?.source),
    capitalRequired:
      explicitCapitalRequired ?? (strike != null && strike > 0 ? strike * 100 : null),
    safeStrike: finiteOrNull(diagnostics?.safeStrike),
    aggressiveStrike: finiteOrNull(diagnostics?.aggressiveStrike),
    midpointStrike: finiteOrNull(diagnostics?.midpointStrike),
    effectivePeriodMinPct: finiteOrNull(diagnostics?.effectivePeriodMinPct),
    effectivePeriodMaxPct: finiteOrNull(diagnostics?.effectivePeriodMaxPct),
    primaryReason: stringOrNull(
      diagnostics?.diagnostics?.nativePrimaryReason,
      diagnostics?.primaryReason,
      diagnostics?.reasonCode,
      legView?.selectionReason,
    ),
    selectedForBalanced: available,
    diagnostics,
  };
}

export function resolveDashboardModeForFilter(item) {
  const explicitMode = stringOrNull(
    item?.capitalComboBucketMode,
    item?.bucketMode,
    item?.balancedCardViewModel?.mode,
  )?.toUpperCase();
  const balancedSource = stringOrNull(
    item?.balancedCardViewModel?.source,
    item?.balancedLegSource,
  )?.toUpperCase();
  if (
    explicitMode === "BALANCED" &&
    (item?.balancedCardViewModel?.available === true ||
      BALANCED_AVAILABLE_SOURCES.has(balancedSource))
  ) {
    return "BALANCED";
  }
  if (BALANCED_AVAILABLE_SOURCES.has(balancedSource)) return "BALANCED";
  if (explicitMode === "SAFE" || explicitMode === "AGGRESSIVE") return explicitMode;
  return getFinalDisplayRecommendation(item)?.finalDisplayMode ?? null;
}
