import {
  BALANCED_LEG_SOURCES,
  BALANCED_NATIVE_REASON_CODES,
  getAggressivePriorityGrade,
  getLegDistancePct,
  getLegPeriodYieldPct,
  gradeLeg,
  normalizeOptionalPopDecimal,
  resolveBalancedLegSelection,
  resolveLegSpreadDiagnostics,
} from "./capitalComboPortfolio.js";

const IDENTITY_ORDER = Object.freeze({
  SAFE: 0,
  BALANCED: 1,
  AGGRESSIVE: 2,
});

const TOP_MIN_POP_PCT = 85;
const TOP_MAX_SPREAD_PCT = 20;

function readKnownEarningsDayCount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowHasEarningsVeto(row) {
  if (row?.recommendationDiagnostics?.earningsRisk === true) return true;
  if (row?.hasUpcomingEarningsBeforeExpiration === true) return true;
  if (row?.hasEarningsBeforeExpiration === true) return true;
  const days = readKnownEarningsDayCount(row?.earningsDaysUntil);
  return days != null && days >= 0 && days <= 7;
}

function readDefinitiveRejections(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}

function vetoForMode(mode, { earningsRisk = false, definitiveRejections = null } = {}) {
  if (mode === "AGGRESSIVE" && earningsRisk === true) {
    return { veto: true, vetoCode: "earningsRisk" };
  }
  const code = definitiveRejections?.[mode];
  if (typeof code === "string" && code.trim()) {
    return { veto: true, vetoCode: code.trim() };
  }
  if (code === true) return { veto: true, vetoCode: "definitiveRejection" };
  return { veto: false, vetoCode: null };
}

function nativeResolutionFromRow(row) {
  if (row?.balancedResolution && typeof row.balancedResolution === "object") {
    return row.balancedResolution;
  }
  const engine = resolveBalancedLegSelection({ candidate: row });
  if (engine?.source === BALANCED_LEG_SOURCES.NATIVE && engine.selectedLeg) return engine;
  const viewModel = row?.balancedCardViewModel;
  if (
    viewModel?.available === true &&
    viewModel?.source === BALANCED_LEG_SOURCES.NATIVE &&
    Number.isFinite(Number(viewModel?.strike))
  ) {
    return {
      source: BALANCED_LEG_SOURCES.NATIVE,
      selectedLeg: {
        strike: viewModel.strike,
        bid: viewModel.bid ?? null,
        ask: viewModel.ask ?? null,
        mid: viewModel.mid ?? null,
        premiumUsed: viewModel.premium ?? null,
        weeklyYield: viewModel.periodYieldPct ?? null,
        distancePct: viewModel.distancePct ?? null,
        popProfitEstimated: viewModel.popDecimal ?? null,
        spreadPct: viewModel.spreadPct ?? null,
        volume: viewModel.volume ?? null,
        openInterest: viewModel.openInterest ?? null,
        liquidity: { spreadPct: viewModel.spreadPct ?? null },
        optionSymbol: viewModel.optionSymbol ?? null,
        conId: viewModel.conId ?? null,
      },
      reasonCode: viewModel.primaryReason ?? BALANCED_NATIVE_REASON_CODES.SELECTED,
      primaryReason: viewModel.primaryReason ?? BALANCED_NATIVE_REASON_CODES.SELECTED,
    };
  }
  return engine;
}

function evaluateLeg(mode, leg, { veto = false, vetoCode = null, allowPriority = false, source = null } = {}) {
  if (!leg || !Number.isFinite(Number(leg.strike))) {
    return {
      mode,
      present: false,
      admissible: false,
      executable: false,
      grade: "REJECT",
      reasonCode: "MISSING",
      veto: false,
      source: source ?? mode,
      leg: null,
    };
  }

  const spreadDiag = resolveLegSpreadDiagnostics(leg);
  const spreadPct = Number.isFinite(Number(spreadDiag.spreadPct)) ? Number(spreadDiag.spreadPct) : null;
  const spreadRejected = Boolean(spreadDiag.rejectionReason) || (spreadPct != null && spreadPct < 0);
  const periodYieldPct = getLegPeriodYieldPct(leg);
  const popDecimal = normalizeOptionalPopDecimal(leg.popProfitEstimated ?? leg.popEstimate);
  const popPct = popDecimal == null ? null : popDecimal * 100;
  const distancePct = getLegDistancePct(leg);
  const priority =
    allowPriority && !veto && !spreadRejected
      ? getAggressivePriorityGrade({
          spreadPct,
          weeklyYieldPct: periodYieldPct,
          popDecimal,
          distancePct,
        })
      : null;
  const baseGrade = spreadRejected
    ? "REJECT"
    : gradeLeg({
        spreadPct,
        weeklyYieldPct: periodYieldPct,
        popDecimal,
      });
  const grade = veto ? "REJECT" : priority ?? baseGrade;
  const popKnown = Number.isFinite(popPct);
  const spreadFinite = spreadPct != null && spreadPct >= 0 && !spreadRejected;
  const gradeExecutable = grade === "A" || grade === "B";
  const admissible = !veto && !spreadRejected && grade !== "REJECT";
  const executable = admissible && gradeExecutable && popKnown && spreadFinite;
  let reasonCode = null;
  if (veto) reasonCode = vetoCode || "earningsRisk";
  else if (spreadDiag.rejectionReason) reasonCode = spreadDiag.rejectionReason;
  else if (spreadPct != null && spreadPct < 0) reasonCode = "NEGATIVE_SPREAD_PCT";
  else if (grade === "REJECT") reasonCode = "GRADE_REJECT";
  else if (gradeExecutable && !popKnown) reasonCode = "POP_UNKNOWN";

  return {
    mode,
    present: true,
    admissible,
    executable,
    grade,
    popKnown,
    popPct,
    spreadPct,
    spreadFinite,
    distancePct: Number.isFinite(distancePct) ? distancePct : null,
    periodYieldPct: Number.isFinite(periodYieldPct) ? periodYieldPct : null,
    strike: Number(leg.strike),
    veto,
    reasonCode,
    source: source ?? mode,
    leg,
  };
}

function sameMeasuredNumber(left, right) {
  return Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= 1e-9;
}

function comparePrincipalLegs(left, right) {
  const gradeRank = (grade) => (grade === "A" ? 0 : grade === "B" ? 1 : 2);
  const gradeDelta = gradeRank(left.grade) - gradeRank(right.grade);
  if (gradeDelta) return gradeDelta;
  const leftSpread = Number.isFinite(left.spreadPct) ? left.spreadPct : Number.POSITIVE_INFINITY;
  const rightSpread = Number.isFinite(right.spreadPct) ? right.spreadPct : Number.POSITIVE_INFINITY;
  if (!sameMeasuredNumber(leftSpread, rightSpread)) return leftSpread - rightSpread;
  const leftPop = Number.isFinite(left.popPct) ? left.popPct : Number.NEGATIVE_INFINITY;
  const rightPop = Number.isFinite(right.popPct) ? right.popPct : Number.NEGATIVE_INFINITY;
  if (leftPop !== rightPop) return rightPop - leftPop;
  const leftDistance = Number.isFinite(left.distancePct) ? left.distancePct : Number.POSITIVE_INFINITY;
  const rightDistance = Number.isFinite(right.distancePct) ? right.distancePct : Number.POSITIVE_INFINITY;
  if (leftDistance !== rightDistance) return leftDistance - rightDistance;
  const leftYield = Number.isFinite(left.periodYieldPct) ? left.periodYieldPct : Number.NEGATIVE_INFINITY;
  const rightYield = Number.isFinite(right.periodYieldPct) ? right.periodYieldPct : Number.NEGATIVE_INFINITY;
  if (leftYield !== rightYield) return rightYield - leftYield;
  const leftStrike = Number.isFinite(left.strike) ? left.strike : Number.POSITIVE_INFINITY;
  const rightStrike = Number.isFinite(right.strike) ? right.strike : Number.POSITIVE_INFINITY;
  if (leftStrike !== rightStrike) return leftStrike - rightStrike;
  return (IDENTITY_ORDER[left.mode] ?? 9) - (IDENTITY_ORDER[right.mode] ?? 9);
}

function emptySelection(exclusions) {
  return {
    finalDisplayMode: "REJECT",
    finalDisplayGrade: "REJECT",
    selectedLeg: null,
    selectedLegSource: null,
    executable: false,
    topExecutableEligible: false,
    spreadPct: null,
    popPct: null,
    distancePct: null,
    periodYieldPct: null,
    strike: null,
    selectionPool: "NONE",
    legs: [],
    exclusions,
  };
}

/**
 * Choix principal du scan. Ne modifie pas le classement des combinaisons.
 * Seule une jambe BALANCED_NATIVE peut occuper la troisième place.
 */
export function selectPrincipalThreeLeg({
  safeLeg = null,
  aggressiveLeg = null,
  balancedResolution = null,
  candidate = null,
  earningsRisk = false,
  definitiveRejections = null,
} = {}) {
  const resolution = balancedResolution ?? (candidate ? nativeResolutionFromRow(candidate) : null);
  const rejections = readDefinitiveRejections(definitiveRejections);
  const safeVeto = vetoForMode("SAFE", { definitiveRejections: rejections });
  const aggressiveVeto = vetoForMode("AGGRESSIVE", { earningsRisk, definitiveRejections: rejections });
  const entries = [
    evaluateLeg("SAFE", safeLeg, safeVeto),
    evaluateLeg("AGGRESSIVE", aggressiveLeg, { ...aggressiveVeto, allowPriority: true }),
  ];

  const exclusions = [];
  const nativeSource = resolution?.source ?? null;
  const nativeLeg =
    nativeSource === BALANCED_LEG_SOURCES.NATIVE && resolution?.selectedLeg ? resolution.selectedLeg : null;
  if (nativeLeg) {
    entries.push(
      evaluateLeg("BALANCED", nativeLeg, {
        source: BALANCED_LEG_SOURCES.NATIVE,
      }),
    );
  } else {
    exclusions.push({
      mode: "BALANCED",
      reasonCode:
        resolution?.reasonCode ||
        resolution?.primaryReason ||
        BALANCED_NATIVE_REASON_CODES.CHAIN_MISSING,
    });
  }

  const presentEntries = entries.filter((entry) => entry.present);
  const executablePool = presentEntries.filter((entry) => entry.executable);
  const watchPool = presentEntries.filter((entry) => entry.admissible && entry.grade === "WATCH");
  const surveillancePool = presentEntries.filter(
    (entry) => entry.admissible && !entry.executable && entry.grade !== "WATCH",
  );

  let winner = null;
  let selectionPool = "NONE";
  if (executablePool.length > 0) {
    winner = executablePool.slice().sort(comparePrincipalLegs)[0];
    selectionPool = "EXECUTABLE";
  } else if (watchPool.length > 0) {
    winner = watchPool.slice().sort(comparePrincipalLegs)[0];
    selectionPool = "WATCH";
  } else if (surveillancePool.length > 0) {
    winner = surveillancePool.slice().sort(comparePrincipalLegs)[0];
    selectionPool = "SURVEILLANCE";
  }

  for (const entry of presentEntries) {
    if (winner && entry === winner) continue;
    exclusions.push({
      mode: entry.mode,
      reasonCode: entry.reasonCode || "OUTRANKED",
    });
  }
  exclusions.sort(
    (left, right) => (IDENTITY_ORDER[left.mode] ?? 9) - (IDENTITY_ORDER[right.mode] ?? 9),
  );

  if (!winner) return emptySelection(exclusions);

  const topExecutableEligible =
    selectionPool === "EXECUTABLE" &&
    winner.executable === true &&
    (winner.grade === "A" || winner.grade === "B") &&
    winner.popKnown === true &&
    winner.popPct >= TOP_MIN_POP_PCT &&
    Number.isFinite(winner.spreadPct) &&
    winner.spreadPct <= TOP_MAX_SPREAD_PCT &&
    winner.veto !== true;

  return {
    finalDisplayMode: winner.mode,
    finalDisplayGrade: winner.grade,
    selectedLeg: winner.leg,
    selectedLegSource: winner.source,
    executable: winner.executable === true,
    topExecutableEligible,
    spreadPct: winner.spreadPct,
    popPct: winner.popPct,
    distancePct: winner.distancePct,
    periodYieldPct: winner.periodYieldPct,
    strike: winner.strike,
    selectionPool,
    legs: presentEntries.map((entry) => ({
      mode: entry.mode,
      grade: entry.grade,
      executable: entry.executable,
      source: entry.source,
      spreadPct: entry.spreadPct,
      popPct: entry.popPct,
    })),
    exclusions,
  };
}

export function selectPrincipalThreeLegFromRow(row) {
  const diagnostics = row?.recommendationDiagnostics ?? null;
  return selectPrincipalThreeLeg({
    safeLeg: row?.safeStrike ?? null,
    aggressiveLeg: row?.aggressiveStrike ?? null,
    candidate: row,
    earningsRisk: rowHasEarningsVeto(row),
    definitiveRejections: diagnostics?.definitiveRejections ?? null,
  });
}
