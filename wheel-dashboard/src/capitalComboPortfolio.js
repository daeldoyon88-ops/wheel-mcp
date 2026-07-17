/**
 * Moteur combinaisons capital — extrait de dashboard.jsx pour réutilisation Node (simulation) et React.
 * Ne fait aucun fetch réseau.
 */
import { getTickerDisplayMeta } from "./tickerMeta.js";
import {
  CAPITAL_COMBO_OPTIMIZER_DEFAULTS,
  resolveCapitalOptimizerV2Flags,
  mergeRejectionDiagnostics,
  compareLeftoverDensityOrder,
  computeLeftoverActionThresholdUsd,
  premiumDensityScore,
  buildNextBestResidualRows,
  buildScoredPoolNotSelectedDiagnostics,
  summarizeBlockerHits,
  formatCapBlockerReason,
  buildTerminalUnusedCapitalDiagnostic,
} from "./capitalComboEngineV2.js";
import { buildAlternativeCompositionSimV1 } from "./alternativeCompositionSimV1.js";

/**
 * AF-05 — Départage final stable et déterministe entre deux candidats parfaitement
 * égaux selon TOUS les critères métier existants.
 *
 * N'est jamais utilisé pour départager avant l'égalité complète des critères métier :
 * il sert uniquement de dernier recours pour rendre le résultat indépendant de
 * l'ordre du tableau d'entrée, du tri d'affichage, de l'ordre de récupération des
 * données et de l'environnement d'exécution.
 *
 * Ne modifie aucun objet, ne dépend pas de l'index d'entrée, ni du rang UI/scanner,
 * ni de Date.now(), ni d'aucune source aléatoire. Mode-agnostique (compatible SAFE,
 * BALANCED — future vraie jambe incluse — et AGGRESSIVE).
 *
 * Retourne < 0 si `a` doit passer avant `b`, > 0 sinon, 0 si strictement indiscernable.
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
export function compareCapitalComboCandidatesStable(a, b) {
  // 1. Ticker normalisé, ordre alphabétique croissant.
  const tickerA = String(a?.ticker ?? a?.symbol ?? "").trim().toUpperCase();
  const tickerB = String(b?.ticker ?? b?.symbol ?? "").trim().toUpperCase();
  if (tickerA !== tickerB) return tickerA < tickerB ? -1 : 1;

  // 2. Strike sélectionné croissant.
  const rawStrikeA = Number(a?.selectedStrike?.strike ?? a?.selectedStrikeValue ?? NaN);
  const rawStrikeB = Number(b?.selectedStrike?.strike ?? b?.selectedStrikeValue ?? NaN);
  const strikeA = Number.isFinite(rawStrikeA) ? rawStrikeA : Number.POSITIVE_INFINITY;
  const strikeB = Number.isFinite(rawStrikeB) ? rawStrikeB : Number.POSITIVE_INFINITY;
  if (strikeA !== strikeB) return strikeA < strikeB ? -1 : 1;

  // 3. Mode sélectionné dans un ordre canonique.
  const modeRank = (mode) => {
    const m = String(mode ?? "").trim().toUpperCase();
    if (m === "SAFE") return 0;
    if (m === "BALANCED") return 1;
    if (m === "AGGRESSIVE") return 2;
    return 3;
  };
  const rankA = modeRank(a?.finalDisplayMode);
  const rankB = modeRank(b?.finalDisplayMode);
  if (rankA !== rankB) return rankA - rankB;

  // 4. Clé stable construite uniquement depuis les données du candidat.
  const stableKey = (c) =>
    [
      String(
        c?.selectedExpiration ??
          c?.targetExpiration ??
          c?.expiration ??
          c?.optionsExpiration ??
          "",
      ),
      Number.isFinite(Number(c?.capitalPerContract)) ? Number(c.capitalPerContract) : "",
      Number.isFinite(Number(c?.premiumPerContract)) ? Number(c.premiumPerContract) : "",
      String(c?.finalDisplayGrade ?? ""),
      String(c?.source ?? ""),
    ].join("|");
  const keyA = stableKey(a);
  const keyB = stableKey(b);
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;

  return 0;
}

/**
 * Convention canonique spreadPctPercent : toujours en pourcentage (0.8 = 0,8 %, 5 = 5 %, 80 = 80 %).
 * @param {number|null|undefined} raw
 * @param {{ source?: string, alreadyPercent?: boolean }} [options]
 */
export function toSpreadPctPercent(raw, options = {}) {
  if (raw == null) return null;
  const { source, alreadyPercent } = options;
  const x = Number(raw);
  if (!Number.isFinite(x)) return null;
  if (alreadyPercent === true) return x;
  if (source === "ibkr_raw_fraction") return x * 100;
  if (source === "dashboard_percent" || source === "yahoo_percent") return x;
  // Source inconnue : pas de heuristique ≤1 → évite double conversion.
  return x;
}

/** Codes de rejet spread (AF-11) — diagnostics lecture seule. */
export const SPREAD_PCT_REJECTION = Object.freeze({
  CROSSED_MARKET: "CROSSED_MARKET",
  NEGATIVE_SPREAD_PCT: "NEGATIVE_SPREAD_PCT",
  INVALID_MID: "INVALID_MID",
});

function legBidAskFinite(leg) {
  const rawBid = leg?.bid;
  const rawAsk = leg?.ask;
  const bidOk =
    rawBid != null &&
    rawBid !== "" &&
    Number.isFinite(Number(rawBid)) &&
    Number(rawBid) >= 0;
  const askOk =
    rawAsk != null &&
    rawAsk !== "" &&
    Number.isFinite(Number(rawAsk)) &&
    Number(rawAsk) >= 0;
  return {
    bid: bidOk ? Number(rawBid) : null,
    ask: askOk ? Number(rawAsk) : null,
    both: bidOk && askOk,
  };
}

function computeSpreadPctFromBidAsk(bid, ask) {
  if (bid > ask) {
    return { spreadPct: null, rejectionReason: SPREAD_PCT_REJECTION.CROSSED_MARKET };
  }
  if (bid === ask) return { spreadPct: 0, rejectionReason: null };
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) {
    return { spreadPct: null, rejectionReason: SPREAD_PCT_REJECTION.INVALID_MID };
  }
  return { spreadPct: ((ask - bid) / mid) * 100, rejectionReason: null };
}

function resolveProvidedSpreadPctPercent(leg) {
  if (!leg || typeof leg !== "object") return { spreadPct: null, rejectionReason: null };
  if (leg.liquidity?.spreadPct != null) {
    const pct = toSpreadPctPercent(leg.liquidity.spreadPct, { source: "dashboard_percent" });
    if (pct != null && pct < 0) {
      return { spreadPct: null, rejectionReason: SPREAD_PCT_REJECTION.NEGATIVE_SPREAD_PCT };
    }
    return { spreadPct: pct, rejectionReason: null };
  }
  if (leg.spreadPct == null) return { spreadPct: null, rejectionReason: null };
  const rawSpread = leg.spreadPct;
  const rawIbkr = leg.raw?.spreadPct;
  let pct;
  if (
    leg.source === "IBKR live" &&
    rawIbkr != null &&
    Number(rawSpread) === Number(rawIbkr)
  ) {
    pct = toSpreadPctPercent(rawSpread, { source: "ibkr_raw_fraction" });
  } else {
    pct = toSpreadPctPercent(rawSpread, { source: "dashboard_percent" });
  }
  if (pct != null && pct < 0) {
    return { spreadPct: null, rejectionReason: SPREAD_PCT_REJECTION.NEGATIVE_SPREAD_PCT };
  }
  return { spreadPct: pct, rejectionReason: null };
}

/**
 * AF-11 — Source de vérité spread jambe.
 * Si bid et ask sont tous deux finis et ≥ 0, ils ont priorité sur spreadPct fourni.
 * Ne jamais clamper un spread négatif à 0.
 */
export function resolveLegSpreadDiagnostics(leg) {
  if (!leg || typeof leg !== "object") return { spreadPct: null, rejectionReason: null };
  const book = legBidAskFinite(leg);
  if (book.both) {
    return computeSpreadPctFromBidAsk(book.bid, book.ask);
  }
  return resolveProvidedSpreadPctPercent(leg);
}

/** Jambe shortlist/dashboard — spread en points de pourcentage (5 = 5 %). */
export function resolveLegSpreadPctPercent(leg) {
  return resolveLegSpreadDiagnostics(leg).spreadPct;
}

export function normalizeOptionalPopDecimal(value) {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

function firstKnownOptionalPopDecimal(...values) {
  for (const value of values) {
    const normalized = normalizeOptionalPopDecimal(value);
    if (normalized != null) return normalized;
  }
  return null;
}

function normalizeOptionalPopPct(value) {
  const decimal = normalizeOptionalPopDecimal(value);
  return decimal == null ? null : decimal * 100;
}

/** AF-18 — résolution pure : options explicites ou defaults ; jamais localStorage. */
function resolveOptimizerV2ForCombo(overrideFlags) {
  return resolveCapitalOptimizerV2Flags(overrideFlags);
}

/** Symboles focal — même liste que dans l’export `nearMissFocus` (diagnostic lecture seule). */
/** Seuil executionScore AGGRESSIVE — distinct de SAFE/BALANCED (0). Candidats ≥ seuil admissibles au scoredPool. */
export const CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE = 0.40;

export const CAPITAL_COMBO_ALLOCATION_TRACE_FOCUS_SYMBOLS = [
  "OKLO",
  "SHOP",
  "CRM",
  "MP",
  "APLD",
  "IONQ",
  "WMT",
  "CVNA",
  "AA",
  "UAL",
  "CCJ",
  "XYZ",
  "LULU",
];

/** Désactivé par défaut : `capitalComboTraceDebug: true` sur `options`, ou env `CAPITAL_COMBO_TRACE_DEBUG=1`. */
export function resolveCapitalComboTraceDebugEnabled(options) {
  if (options && options.capitalComboTraceDebug === true) return true;
  if (typeof process !== "undefined" && process.env && process.env.CAPITAL_COMBO_TRACE_DEBUG === "1") {
    return true;
  }
  return false;
}

function pickFiniteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildShortlistSnapshotRowFromEligibleCandidate(candidate) {
  const missingData = [];
  const safeLeg = candidate?._safeLeg ?? candidate?.safeStrike ?? null;
  const aggLeg = candidate?._aggLeg ?? candidate?.aggressiveStrike ?? null;

  const finalScore =
    candidate?.finalScore != null && Number.isFinite(Number(candidate.finalScore))
      ? Number(candidate.finalScore)
      : candidate?.proFinalScore != null && Number.isFinite(Number(candidate.proFinalScore))
        ? Number(candidate.proFinalScore)
        : null;
  if (finalScore == null) missingData.push("finalScore");

  const qualityScore = pickFiniteOrNull(candidate?.qualityScore ?? candidate?._qualityOverlay?.qualityScore);
  if (qualityScore == null) missingData.push("qualityScore");

  const strike = candidate?.selectedStrikeValue ?? candidate?.strike ?? safeLeg?.strike ?? aggLeg?.strike ?? null;
  if (!Number.isFinite(Number(strike))) missingData.push("strike");

  const bid =
    candidate?.selectedLeg?.bid ??
    aggLeg?.bid ??
    safeLeg?.bid ??
    pickFiniteOrNull(candidate?.premium) ??
    null;
  const premiumUsed =
    candidate?.selectedPremiumUnit ??
    candidate?.selectedLeg?.premiumUsed ??
    pickFiniteOrNull(safeLeg?.premiumUsed ?? safeLeg?.bid) ??
    pickFiniteOrNull(aggLeg?.premiumUsed ?? aggLeg?.bid) ??
    bid;

  if (premiumUsed == null) missingData.push("bidPremium");

  const expiration =
    candidate?.targetExpiration ??
    candidate?.selectedExpiration ??
    candidate?.expiration ??
    candidate?.optionsExpiration ??
    null;
  if (expiration == null) missingData.push("expiration");

  const expectedMovePct =
    pickFiniteOrNull(candidate?.adjustedMovePct) ??
    pickFiniteOrNull(candidate?.expectedMovePct) ??
    (pickFiniteOrNull(candidate?.currentPrice) > 0 && pickFiniteOrNull(candidate?.adjustedMove) != null
      ? (Number(candidate.adjustedMove) / Number(candidate.currentPrice)) * 100
      : pickFiniteOrNull(candidate?.expectedMove));

  const lowerBound = pickFiniteOrNull(candidate?.lowerBound);

  return {
    symbol: String(candidate?.ticker || "").trim().toUpperCase() || null,
    finalScore,
    qualityScore,
    weeklyReturnPct: pickFiniteOrNull(candidate?.weeklyReturn ?? candidate?.selectedYieldPct),
    safeWeeklyReturnPct:
      candidate?._safeYieldPct != null
        ? pickFiniteOrNull(candidate._safeYieldPct)
        : pickFiniteOrNull(safeLeg?.weeklyYield ?? safeLeg?.periodYield),
    aggressiveWeeklyReturnPct:
      candidate?._aggYieldPct != null
        ? pickFiniteOrNull(candidate._aggYieldPct)
        : pickFiniteOrNull(aggLeg?.weeklyYield ?? aggLeg?.periodYield),
    bid,
    premiumOrBidUsedForLeg: premiumUsed,
    strike: pickFiniteOrNull(strike),
    expiration,
    capitalRequiredUsd: candidate?.capitalPerContract != null ? pickFiniteOrNull(candidate.capitalPerContract) : null,
    spreadPct: pickFiniteOrNull(candidate?.spreadPct ?? candidate?.selectedSpreadPct ?? safeLeg?.spreadPct ?? aggLeg?.spreadPct),
    distancePct: pickFiniteOrNull(candidate?.selectedDistancePct ?? candidate?.distancePct ?? safeLeg?.distancePct ?? aggLeg?.distancePct),
    popPct: pickFiniteOrNull(candidate?._popForCombo),
    expectedMovePct: expectedMovePct,
    lowerBound,
    recoveredByYahooLiquidityV3LiveSafe:
      typeof candidate?.recoveredByYahooLiquidityV3LiveSafe === "boolean"
        ? candidate.recoveredByYahooLiquidityV3LiveSafe
        : candidate?.recoveredByYahooLiquidityV3LiveSafe === true
          ? true
          : candidate?.recoveredByYahooLiquidityV3LiveSafe == null
            ? null
            : !!candidate.recoveredByYahooLiquidityV3LiveSafe,
    v3Bucket: candidate?.v3Bucket ?? null,
    v3RiskFlags:
      candidate?.v3RiskFlags ??
      candidate?.yahooLiquidityV3?.riskFlags ??
      candidate?.diagnostics?.v3RiskFlags ??
      candidate?.yahooLiquidityV3Diagnostics?.v3RiskFlags ??
      null,
    missingData: missingData.length ? missingData : undefined,
  };
}

function serializeScoredCandidateForTrace(candidate, rankAfterSort, modeLabel) {
  const bd = candidate?._comboScoreBreakdown ?? null;
  const ov = candidate?._qualityOverlay ?? {};
  const meta = candidate?._tickerMeta ?? {};

  const penaltyHints = [...(Array.isArray(ov.qualityWarnings) ? ov.qualityWarnings : [])];
  const primaryPenaltiesSummary = penaltyHints.slice(0, 8).join("; ") || null;

  return {
    symbol: String(candidate?.ticker || "").trim().toUpperCase() || null,
    modeSimulatedBucket: modeLabel ?? null,
    rankAfterCompositeSort: rankAfterSort ?? null,
    compositeAllocScore:
      candidate?.allocScore != null && Number.isFinite(Number(candidate.allocScore))
        ? Number(candidate.allocScore)
        : null,
    comboScoreBreakdown: bd
      ? {
          totalScore: bd.totalScore ?? null,
          summaryFr: bd.summary ?? null,
          selectionReasonFr: bd.selectionReason ?? null,
          tooltipFr: bd.tooltip ?? null,
        }
      : { missingData: ["_comboScoreBreakdown"] },
    legSummary: {
      weeklyReturnPct:
        candidate?.weeklyReturn ??
        candidate?.selectedYieldPct ??
        null,
      strike: candidate?.selectedStrike?.strike ?? candidate?.selectedStrikeValue ?? null,
      spreadPct: candidate?.spreadPct ?? candidate?.selectedSpreadPct ?? null,
      distancePct: candidate?.selectedDistancePct ?? null,
      popPct: candidate?._popForCombo ?? null,
      capitalUsd: candidate?.capitalPerContract ?? null,
      grade: candidate?.finalDisplayGrade ?? null,
      isWatchPremium: candidate?._isWatchPremium === true,
    },
    qualityOverlay: {
      qualityTier: ov.qualityTier ?? null,
      qualityScore: ov.qualityScore ?? null,
      concentrationTheme: ov.concentrationTheme ?? null,
      speculativePenalty: ov.speculativePenalty ?? null,
      liquidityPenalty: ov.liquidityPenalty ?? null,
      earningsPenalty: ov.earningsPenalty ?? null,
      premiumTrapPenalty: ov.premiumTrapPenalty ?? null,
      penaltyReasonsFrSample: primaryPenaltiesSummary,
    },
    tickerMeta: {
      sector: meta?.sector ?? null,
      name: meta?.name ?? null,
    },
    modeEligibilityPassedScoredPool: true,
    primaryBlocker: null,
  };
}

/** Meilleurs `skipped` par cycle greedy (scores statiques pré-sélection, pas marginalScore filler). */
function summarizeTopGreedySkippedByCycleLimited(cycleTrace, limitCycles = 60, limitPerCycle = 8) {
  if (!Array.isArray(cycleTrace) || cycleTrace.length === 0) return [];
  const byCycle = new Map();
  for (const row of cycleTrace) {
    if (!row || typeof row !== "object") continue;
    if (row.decision !== "skipped") continue;
    const cyc = Number(row.cycle);
    if (!Number.isFinite(cyc)) continue;
    if (!byCycle.has(cyc)) byCycle.set(cyc, []);
    byCycle.get(cyc).push({
      ticker: row.candidateTicker ?? null,
      allocScoreApprox: row.candidateScore ?? null,
      reason: row.reason ?? null,
    });
  }
  const out = [];
  const sortedCycles = [...byCycle.keys()].sort((a, b) => a - b);
  for (const cyc of sortedCycles.slice(0, limitCycles)) {
    const rows = (byCycle.get(cyc) || [])
      .filter((r) => r.ticker)
      .sort((a, b) => Number(b.allocScoreApprox || 0) - Number(a.allocScoreApprox || 0))
      .slice(0, limitPerCycle);
    if (rows.length) out.push({ cycle: cyc, topSkippedGreedyByStaticScore: rows });
  }
  return out;
}

function summarizeRejectionTotalsFromAllocationTrace(rows) {
  if (!Array.isArray(rows)) return {};
  const m = new Map();
  for (const r of rows) {
    const k = String(r.reasonRejected ?? r.blockerType ?? "").trim();
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a, b) => (b[1] || 0) - (a[1] || 0)));
}

function buildNearMissFocusSection(builtCombos, comboTraceSnapshotsByModeLabel) {
  /** @type {Record<string, unknown>} */
  const out = {};
  const combosByLabel = {};
  for (const c of builtCombos || []) {
    combosByLabel[String(c?.label || "").trim()] = c;
  }

  for (const sym of CAPITAL_COMBO_ALLOCATION_TRACE_FOCUS_SYMBOLS) {
    const u = String(sym || "").trim().toUpperCase();
    const modesOut = {};

    let comparedWinnerTickerGuess = null;
    let compareNoteFr = null;
    /** @type {null | number} */
    let bestResidualRankAcrossModes = null;

    for (const label of ["AGGRESSIVE", "BALANCED", "SAFE"]) {
      const combo = combosByLabel[label];
      const modeSnap =
        comboTraceSnapshotsByModeLabel instanceof Map ? comboTraceSnapshotsByModeLabel.get(label) : undefined;

      const scoredList = Array.isArray(modeSnap?.scoredCandidatesOrdered)
        ? modeSnap.scoredCandidatesOrdered
        : [];
      const scoredRow = scoredList.find((row) => String(row?.symbol || "").toUpperCase() === u);

      const rejectedList = Array.isArray(modeSnap?.rejectedBeforeAllocation)
        ? modeSnap.rejectedBeforeAllocation
        : [];
      const rejectedRow =
        rejectedList.find((row) => String(row?.ticker || "").toUpperCase() === u) ?? null;

      const residualRow =
        combo?.capDiagnosticsV2?.nextBestResiduals?.find(
          (row) => String(row?.ticker || "").trim().toUpperCase() === u,
        ) ?? null;

      const inPortfolio =
        Array.isArray(combo?.picks) && combo.picks.some((p) => String(p?.ticker || "").toUpperCase() === u);

      const blockerNotInPool = rejectedRow?.primaryBlocker ?? null;
      const blockerResidual = residualRow?.primaryBlocker ?? null;

      const scoredRank =
        scoredRow?.rankAfterCompositeSort != null ? Number(scoredRow.rankAfterCompositeSort) : null;
      const scoredComposite = scoredRow?.compositeAllocScore != null ? Number(scoredRow.compositeAllocScore) : null;

      modesOut[label] = {
        inPortfolio,
        eligibleForScoredPool: !!scoredRow,
        primaryBlockerNeverReachedScoredPool: blockerNotInPool,
        scoredPoolRank: scoredRank,
        compositeScoreInMode: scoredComposite,
        scoreBreakdown: scoredRow?.comboScoreBreakdown ?? null,
        residualPrimaryBlockerAfterGreedyAllocation: blockerResidual,
        residualRowSummary: residualRow
          ? {
              wedgeDensity: residualRow.wedgeDensity ?? null,
              capitalPerContract: residualRow.capitalPerContract ?? null,
              premiumPerContract: residualRow.premiumPerContract ?? null,
            }
          : null,
        hypotheticalReadOnlyHints: buildHypotheticalHints({
          blockerNotInPool,
          blockerResidual,
          scoredRank,
          inPortfolio,
        }),
      };

      /** Cherche un ticker « gagnant » plausible dans le dernier sweep où ce symbole est skipped (~greedy marginal). */
      if (!comparedWinnerTickerGuess && combo?.capDiagnosticsV2?.allocationTraceV1) {
        const ct = combo.capDiagnosticsV2.allocationTraceV1.cycleTrace;
        if (Array.isArray(ct)) {
          const rowHit = [...ct].reverse().find(
            (r) =>
              String(r?.candidateTicker || "").trim().toUpperCase() === u &&
              r?.decision === "skipped",
          );
          if (rowHit?.cycle != null && rowHit.bestTicker != null) {
            comparedWinnerTickerGuess = String(rowHit.bestTicker).trim().toUpperCase();
            compareNoteFr =
              "Heuristique greedy : dernier sweep cycleTrace où le symbole est « skipped », champ bestTicker (= meilleur marginalScore cette passe). Simulation exhaustive non effectuée.";
          }
        }
      }

      if (scoredRank != null && scoredRank <= 40) {
        if (bestResidualRankAcrossModes == null || scoredRank < bestResidualRankAcrossModes)
          bestResidualRankAcrossModes = scoredRank;
      }
    }

    out[u] = {
      byMode: modesOut,
      comparedToWinnerTickerApprox: comparedWinnerTickerGuess ?? "missingData",
      compareNoteFr: compareNoteFr ?? "Voir cycleTrace/raw pour corrélations précises ; aucun bestTicker trouvé automatiquement.",
      bestApproxRankAcrossModesAmongTop40Hint: bestResidualRankAcrossModes,
    };
  }
  return out;
}

function buildHypotheticalHints({ blockerResidual, blockerNotInPool, scoredRank, inPortfolio }) {
  const capKeys = ["ticker_cap_reached", "theme_cap_reached", "sector_cap_reached", "high_beta_cap_reached"];
  const bk = blockerResidual ?? blockerNotInPool;
  return {
    wouldFitIfRelaxClusterCaps_ApproxLikelyUncertain:
      bk != null && capKeys.includes(String(bk)) ? true : bk == null ? null : false,
    moreCapitalLikelyUnlocksResidual_ApproxLikelyUncertain:
      bk === "contract_size_too_large" ? true : bk == null ? null : false,
    moreMaxPositionsLikelyUnlocksResidual_ApproxLikelyUncertain:
      bk === "max_positions_limit" ? true : bk == null ? null : false,
    ifInScoredPoolButNotPortfolio_GreedyOrMarginal_ApproxLikelyUncertain:
      scoredRank != null ? !inPortfolio : null,
    noteFr:
      "Heuristiques seulement : pas de re-simulation greedy sans caps ou avec capital supplémentaire.",
  };
}

function assembleCapitalComboAllocationTraceV1({
  basePool,
  builtCombos,
  comboTraceSnapshotsByModeLabel,
  grossCapital,
  maxCapitalPct,
  maxPositions,
  usableCapital,
  rejectedIbkrSymbolsSize,
}) {
  const iso = new Date().toISOString();
  /** @type {Record<string, unknown>} */
  const allocationTraceOut = {};

  const scoredCandidatesByMode = {};

  const comboLookup = new Map();
  for (const combo of builtCombos || []) {
    const lk = String(combo?.label ?? "").trim();
    if (lk) comboLookup.set(lk, combo);
  }

  for (const label of ["AGGRESSIVE", "BALANCED", "SAFE"]) {
    const combo = comboLookup.get(label) ?? null;
    const at = combo?.capDiagnosticsV2?.allocationTraceV1 ?? null;
    const snap = comboTraceSnapshotsByModeLabel?.get(label) ?? null;

    allocationTraceOut[label] = {
      bucketLabel: label,
      comboReturnedNull:
        combo == null ? true : undefined,
      positionsInBook: combo?.positions ?? combo?.picks?.length ?? null,
      totalCapitalUsd: combo?.totalCapital ?? null,
      usableCapitalEnvelopeUsd: usableCapital,
      fillEfficiencyPct: combo?.capDiagnosticsV2?.fillEfficiencyPct ?? null,
      blockerSummaryMerged: combo?.capDiagnosticsV2?.blockerSummaryMerged ?? null,
      dominantFillBlocker: combo?.capDiagnosticsV2?.dominantFillBlocker ?? null,
      rejectionTotalsAcrossCycles:
        combo?.capDiagnosticsV2?.rejectionTotalsAcrossCycles ??
        summarizeRejectionTotalsFromAllocationTrace(at?.rejectionTrace),
      capsHitApproxFromRejectionSweep: summarizeRejectionTotalsFromAllocationTrace(at?.rejectionTrace ?? []),
      nextBestResiduals: combo?.capDiagnosticsV2?.nextBestResiduals?.slice(0, 36) ?? null,
      allocationTraceV1: at ?? { missingData: ["allocationTraceV1"] },
      topGreedySkippedByCycleLimited: summarizeTopGreedySkippedByCycleLimited(at?.cycleTrace ?? []),
    };

    scoredCandidatesByMode[label] = {
      rejectedBeforeAllocation: snap?.rejectedBeforeAllocation ?? null,
      scoredCandidatesOrdered: snap?.scoredCandidatesOrdered ?? null,
      institutionalYieldV3Audit: combo?.balancedInstitutionalV3Audit ?? null,
    };
  }

  const nearMissFocus = buildNearMissFocusSection(builtCombos, comboTraceSnapshotsByModeLabel);

  return {
    exportVersion: "capital-combo-allocation-trace-v1",
    exportedAtIso: iso,
    trigger: {
      envCapitalComboTraceDebug: typeof process !== "undefined" ? process.env?.CAPITAL_COMBO_TRACE_DEBUG ?? null : null,
    },
    inputs: {
      grossCapitalUsd: grossCapital,
      maxCapitalPct,
      maxPositionsRequested: maxPositions,
      usableCapitalUsdApprox: usableCapital,
      rejectedIbkrSymbolsCount: rejectedIbkrSymbolsSize,
    },
    shortlistSnapshot:
      Array.isArray(basePool) && basePool.length
        ? basePool.map(buildShortlistSnapshotRowFromEligibleCandidate)
        : { missingData: ["basePool"] },
    scoredCandidatesByMode,
    allocationTrace: allocationTraceOut,
    nearMissFocus,
    notesFr: [
      "Export diagnostic lecture seule : aucune logique greedy / filtres Capital Combo modifiée.",
      "Les hypothèses « hypotheticalReadOnlyHints » sont heuristiques (pas de re-simulation caps off).",
    ],
  };
}

function comboTraceEmitConsoleSummary(payload, writtenPathText) {
  if (!payload) return;
  if (writtenPathText) console.log(`[combo-trace] wrote ${writtenPathText}`);

  const bal = payload.allocationTrace?.BALANCED;
  const agg = payload.allocationTrace?.AGGRESSIVE;
  const bm = bal?.blockerSummaryMerged;
  const am = agg?.blockerSummaryMerged;

  console.log(`[combo-trace] balanced top blockers=${formatTopMergedBlockersForLog(bm)}`);
  console.log(`[combo-trace] aggressive top blockers=${formatTopMergedBlockersForLog(am)}`);

  for (const sym of CAPITAL_COMBO_ALLOCATION_TRACE_FOCUS_SYMBOLS) {
    const row = payload.nearMissFocus?.[sym];
    const modePick =
      ["AGGRESSIVE", "BALANCED", "SAFE"].find(
        (m) => row?.byMode?.[m]?.inPortfolio !== true && row?.byMode?.[m]?.residualPrimaryBlockerAfterGreedyAllocation,
      ) ||
      ["AGGRESSIVE", "BALANCED", "SAFE"].find(
        (m) => row?.byMode?.[m]?.primaryBlockerNeverReachedScoredPool,
      ) ||
      "AGGRESSIVE";
    const br =
      row?.byMode?.[modePick]?.residualPrimaryBlockerAfterGreedyAllocation ??
      row?.byMode?.[modePick]?.primaryBlockerNeverReachedScoredPool ??
      "missingData";
    console.log(`[combo-trace] ${sym} mode=${modePick} blocker=${br}`);
  }
}

function formatTopMergedBlockersForLog(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return "missingData";
  return arr
    .slice(0, 5)
    .map((row) => `${String(row?.reason ?? row?.blockerType ?? "?")}×${Number(row?.count ?? 0)}[${String(row?.source ?? "")}]`)
    .join(" | ");
}

export function gradeLeg({ spreadPct, weeklyYieldPct, popDecimal }) {
  const spread = Number.isFinite(Number(spreadPct)) ? Number(spreadPct) : null;
  const yldRaw = Number(weeklyYieldPct);
  const yld = Number.isFinite(yldRaw) && yldRaw > 0 ? yldRaw : null;
  const pop = normalizeOptionalPopPct(popDecimal);
  if (spread == null) return "WATCH";
  if (spread < 0) return "REJECT";
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
  const popPct = normalizeOptionalPopPct(popDecimal);
  const dist = Number.isFinite(Number(distancePct)) ? Number(distancePct) : null;
  if (spread == null || yld == null || popPct == null || dist == null) return null;
  if (yld < 0.90) return null;
  if (spread > 30) return null;
  if (popPct < 75) return null;
  if (dist > -5) return null;
  return spread <= 15 ? "A" : "B";
}

export function resolveSelectedLegGrade({ explicitGrade, selectedLeg, selectedMode, candidate = null }) {
  const explicit = String(explicitGrade ?? "").trim().toUpperCase();
  if (explicit) return explicit;
  if (!selectedLeg) return null;

  const mode = String(selectedMode ?? selectedLeg?.mode ?? "").trim().toUpperCase();
  const spreadPct = getLegSpreadPct(selectedLeg);
  const weeklyYieldPct = getLegYieldPct(selectedLeg, candidate);
  const popDecimal = firstKnownOptionalPopDecimal(
    selectedLeg?.popProfitEstimated,
    selectedLeg?.popEstimate,
  );
  if (
    spreadPct == null ||
    weeklyYieldPct == null ||
    !Number.isFinite(Number(spreadPct)) ||
    !Number.isFinite(Number(weeklyYieldPct))
  ) {
    return "WATCH";
  }

  if (mode === "AGGRESSIVE") {
    const priorityGrade = getAggressivePriorityGrade({
      spreadPct,
      weeklyYieldPct,
      popDecimal,
      distancePct: getLegDistancePct(selectedLeg),
    });
    if (priorityGrade) return priorityGrade;
  }

  return gradeLeg({ spreadPct, weeklyYieldPct, popDecimal });
}

function getComboGradeScore(grade) {
  const normalized = String(grade ?? "").trim().toUpperCase();
  return normalized === "A" ? 2 : normalized === "B" ? 1 : 0;
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
    /**
     * Borne min de bande alignée sur la décision fonctionnelle : periodYieldPct >= 0,70 %.
     * L'ancien 0.675 assouplissait la borne HEBDOMADAIRE normalisée (AF-17) ; depuis le
     * passage des bandes au rendement période (jusqu'à expiration), la bande officielle
     * BALANCED [0,70 ; 1,05) s'applique sans assouplissement.
     */
    minWeeklyYield: 0.70,
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
  const safePopDecimal = firstKnownOptionalPopDecimal(
    item?.safeStrike?.popProfitEstimated,
    item?.safeStrike?.popEstimate,
  );
  const aggressivePopDecimal = firstKnownOptionalPopDecimal(
    item?.aggressiveStrike?.popProfitEstimated,
    item?.aggressiveStrike?.popEstimate,
    diag?.aggressivePop,
  );
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
  return resolveLegSpreadPctPercent(leg);
}

/** DTE strictement positif et fini — utilisé pour la normalisation hebdomadaire AF-17. */
export function isValidComboDte(dte) {
  const n = Number(dte);
  return Number.isFinite(n) && n > 0;
}

/** DTE résolu : jambe d'abord, puis candidat parent (dteDays, dteAtScan, dte). */
export function resolveLegDte(leg, candidate) {
  const raw = pickMetadataNumber(
    leg?.dteDays,
    leg?.dte,
    candidate?.dteDays,
    candidate?.dteAtScan,
    candidate?.dte,
  );
  return isValidComboDte(raw) ? raw : null;
}

/** Politique hybride de rendement par DTE — source de vérité unique (moteur + UI). */
export const YIELD_POLICY_VERSION = "hybrid-period-v1";

/** Minimum SAFE canonique : 26 % annualisé simple (pas 0,45 % ni 0,49 % arrondi). */
export const SAFE_ANNUAL_SIMPLE_MIN_PCT = 26;

/** Base hebdomadaire exacte : 26 × 7 / 365 = 0,4986301369863014 % */
export const SAFE_BASE_PERIOD_MIN_PCT = (SAFE_ANNUAL_SIMPLE_MIN_PCT * 7) / 365;

/** Bandes de base (DTE ≤ 7, facteur 1) — pourcentage, pas fraction décimale. */
export const BASE_PERIOD_YIELD_BANDS = Object.freeze({
  SAFE: Object.freeze({
    minPct: SAFE_BASE_PERIOD_MIN_PCT,
    maxPct: 0.8,
    annualizedSimpleMinPct: SAFE_ANNUAL_SIMPLE_MIN_PCT,
  }),
  BALANCED: Object.freeze({
    minPct: 0.7,
    maxPct: 1.05,
    annualizedSimpleMinPct: null,
  }),
  AGGRESSIVE: Object.freeze({
    minPct: 0.95,
    maxPct: null,
    annualizedSimpleMinPct: null,
  }),
});

export function normalizeYieldPolicyMode(mode) {
  const m = String(mode || "").trim().toUpperCase();
  if (m === "CONSERVATIVE" || m === "SAFE") return "SAFE";
  if (m === "BALANCED" || m === "ÉQUILIBRÉ") return "BALANCED";
  if (m === "AGGRESSIVE" || m === "AGRESSIF") return "AGGRESSIVE";
  return m;
}

/**
 * Bande effective de rendement période pour un bucket et un DTE.
 * DTE ≤ 7 : facteur 1 ; DTE > 7 : bornes × DTE / 7.
 */
export function getCanonicalPeriodYieldBand(mode, dteDays) {
  const normalizedMode = normalizeYieldPolicyMode(mode);
  const base = BASE_PERIOD_YIELD_BANDS[normalizedMode];
  const dte = Number(dteDays);

  if (!base) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  if (!Number.isFinite(dte) || dte <= 0) {
    throw new Error(`Invalid DTE: ${dteDays}`);
  }

  const dteScaleFactor = dte > 7 ? dte / 7 : 1;

  return {
    mode: normalizedMode,
    yieldPolicyVersion: YIELD_POLICY_VERSION,
    dteDays: dte,
    dteScaleFactor,
    annualizedSimpleMinPct: base.annualizedSimpleMinPct,
    basePeriodMinPct: base.minPct,
    basePeriodMaxPct: base.maxPct,
    effectivePeriodMinPct: base.minPct * dteScaleFactor,
    effectivePeriodMaxPct: base.maxPct == null ? null : base.maxPct * dteScaleFactor,
    weeklyEquivalentMinPct: base.minPct,
    weeklyEquivalentMaxPct: base.maxPct,
  };
}

export function isPeriodYieldAdmissibleInBand(periodYieldPct, band) {
  const y = Number(periodYieldPct);
  if (!Number.isFinite(y)) return false;
  const min = Number(band?.effectivePeriodMinPct);
  if (!Number.isFinite(min) || !(y >= min)) return false;
  if (band.effectivePeriodMaxPct != null && !(y < band.effectivePeriodMaxPct)) return false;
  return true;
}

/** Statut informatif de rendement BALANCED, sans effet sur l'admissibilite. */
export function getBalancedYieldBandStatus(periodYieldPct, band) {
  const y = Number(periodYieldPct);
  const min = Number(band?.effectivePeriodMinPct);
  if (!Number.isFinite(y) || !Number.isFinite(min)) return null;
  if (y < min) return "BELOW";
  const max = band?.effectivePeriodMaxPct == null
    ? null
    : Number(band.effectivePeriodMaxPct);
  if (max != null && Number.isFinite(max) && y >= max) return "ABOVE";
  return "WITHIN";
}

export function formatPeriodYieldBandDisplayPct(pct, { decimals = 2 } = {}) {
  if (pct == null || !Number.isFinite(Number(pct))) return "n/d";
  return Number(pct).toFixed(decimals);
}

/** Affichage UI du minimum SAFE de base (arrondi à 0,50 %, jamais utilisé par le moteur). */
export function formatSafeBaseMinDisplayPct() {
  return "0.50";
}

export function formatEffectiveYieldBandDisplay(band) {
  if (!band) return "n/d";
  const baseMin =
    band.mode === "SAFE"
      ? formatSafeBaseMinDisplayPct()
      : formatPeriodYieldBandDisplayPct(band.basePeriodMinPct);
  const baseMax =
    band.basePeriodMaxPct == null
      ? null
      : formatPeriodYieldBandDisplayPct(band.basePeriodMaxPct);
  const effMin = formatPeriodYieldBandDisplayPct(band.effectivePeriodMinPct);
  const effMax =
    band.effectivePeriodMaxPct == null
      ? null
      : formatPeriodYieldBandDisplayPct(band.effectivePeriodMaxPct);
  if (band.dteDays <= 7) {
    return baseMax != null ? `${baseMin}%–${baseMax}%` : `≥${baseMin}%`;
  }
  return effMax != null ? `${effMin}%–${effMax}%` : `≥${effMin}%`;
}

export function formatHybridYieldPolicyCardLines(band) {
  if (!band) return [];
  const baseMin =
    band.mode === "SAFE"
      ? formatSafeBaseMinDisplayPct()
      : formatPeriodYieldBandDisplayPct(band.basePeriodMinPct);
  const baseMax =
    band.basePeriodMaxPct == null
      ? null
      : formatPeriodYieldBandDisplayPct(band.basePeriodMaxPct);
  const effMin = formatPeriodYieldBandDisplayPct(band.effectivePeriodMinPct);
  const effMax =
    band.effectivePeriodMaxPct == null
      ? null
      : formatPeriodYieldBandDisplayPct(band.effectivePeriodMaxPct);
  const factor = Number(band.dteScaleFactor).toFixed(2);
  const dteLabel = band.dteDays <= 7 ? `${band.dteDays} DTE ou moins` : `${band.dteDays} DTE`;
  const lines = [`Politique hybride · ${dteLabel}`];
  if (band.mode === "SAFE") {
    lines.push("Minimum SAFE : 26 % annualisé simple");
  }
  if (band.dteDays <= 7) {
    lines.push(
      `Cible effective : ${baseMin}%${baseMax != null ? `–${baseMax}%` : "+"} jusqu'à expiration`,
    );
    lines.push(
      `Équivalent hebdomadaire : ${baseMin}%${baseMax != null ? `–${baseMax}%` : "+"} / 7J`,
    );
  } else {
    lines.push(
      `Base jusqu'à 7 DTE : ${baseMin}%${baseMax != null ? `–${baseMax}%` : "+"} jusqu'à expiration`,
    );
    if (effMax != null) {
      lines.push(`Cible effective ${band.dteDays} DTE : ${effMin}%–${effMax}% jusqu'à expiration`);
    } else {
      lines.push(`Cible effective ${band.dteDays} DTE : ≥${effMin}% jusqu'à expiration`);
    }
    lines.push(
      `Équivalent hebdomadaire : ${baseMin}%${baseMax != null ? `–${baseMax}%` : "+"} / 7J`,
    );
  }
  lines.push(`Facteur : ${factor}×`);
  return lines;
}

export function buildYieldPolicyRejectionFields(
  mode,
  dteDays,
  periodYieldPct,
  weeklyNormalizedYieldPct,
) {
  const band = getCanonicalPeriodYieldBand(mode, dteDays);
  return {
    yieldPolicyVersion: YIELD_POLICY_VERSION,
    mode: band.mode,
    dteDays: band.dteDays,
    dteScaleFactor: band.dteScaleFactor,
    annualizedSimpleMinPct: band.annualizedSimpleMinPct,
    periodYieldPct: Number.isFinite(Number(periodYieldPct)) ? Number(periodYieldPct) : null,
    weeklyNormalizedYieldPct: Number.isFinite(Number(weeklyNormalizedYieldPct))
      ? Number(weeklyNormalizedYieldPct)
      : null,
    basePeriodMinPct: band.basePeriodMinPct,
    basePeriodMaxPct: band.basePeriodMaxPct,
    effectivePeriodMinPct: band.effectivePeriodMinPct,
    effectivePeriodMaxPct: band.effectivePeriodMaxPct,
    minPeriodYieldPct: band.effectivePeriodMinPct,
    yieldPolicyNoteFr:
      band.dteDays > 7
        ? `Seuils période multipliés par DTE/7 (${band.dteScaleFactor.toFixed(4)}×) ; minimum SAFE basé sur 26 % annualisé simple.`
        : "Seuils fixes jusqu'à 7 DTE ; minimum SAFE basé sur 26 % annualisé simple.",
  };
}

function hasExplicitInvalidDte(leg, candidate) {
  for (const value of [
    leg?.dteDays,
    leg?.dte,
    candidate?.dteDays,
    candidate?.dteAtScan,
    candidate?.dte,
  ]) {
    if (value == null || value === "") continue;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return true;
  }
  return false;
}

function isDteFieldUnset(leg, candidate) {
  const legUnset =
    (leg == null || (leg.dteDays === undefined && leg.dte === undefined));
  const candUnset =
    candidate == null ||
    (candidate.dteDays === undefined &&
      candidate.dteAtScan === undefined &&
      candidate.dte === undefined);
  return legUnset && candUnset;
}

function normalizeWeeklyYieldPctReading(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n > 0 && n <= 0.05) return n * 100;
  return n;
}

function periodYieldPctToWeeklyNormalized(periodYieldPct, dte) {
  if (!isValidComboDte(dte)) return null;
  const period = Number(periodYieldPct);
  if (!Number.isFinite(period) || period <= 0) return null;
  const weekly = (period * 7) / dte;
  return Number.isFinite(weekly) && weekly > 0 ? weekly : null;
}

/**
 * Rendement brut jusqu'à expiration (%), ex. 0,50 pour 0,50 %.
 * `weeklyYield` / `periodYield` historiques du scanner/dashboard sont traités comme période.
 */
export function getLegPeriodYieldPct(leg, candidate) {
  const directYield = Number(leg?.periodYield ?? leg?.weeklyYield ?? NaN);
  if (Number.isFinite(directYield) && directYield > 0) return directYield;
  const strike = Number(leg?.strike ?? NaN);
  const premium = getLegPremiumValue(leg);
  if (Number.isFinite(strike) && strike > 0 && Number.isFinite(premium) && premium > 0) {
    return (premium / strike) * 100;
  }
  const explicitPeriod = Number(candidate?.selectedPeriodYieldPct ?? candidate?.periodYieldPct ?? NaN);
  if (Number.isFinite(explicitPeriod) && explicitPeriod > 0) return explicitPeriod;
  return null;
}

/** Compatibilité legacy — rendement de période (%). */
export function getLegYieldPct(leg, candidate) {
  return getLegPeriodYieldPct(leg, candidate);
}

/**
 * Rendement hebdomadaire linéarisé (%) — scoring / affichage / comparaison DTE (AF-17).
 * N'est PLUS utilisé pour l'admissibilité des bandes de bucket : les bandes
 * SAFE/BALANCED/AGGRESSIVE se décident sur le rendement PÉRIODE (jusqu'à
 * expiration, getLegPeriodYieldPct). Le 7J reste calculé/affiché/persisté.
 * Priorité : leg.weeklyNormalizedYield → recalcul période×7/DTE → legacy DTE=7 seulement.
 */
export function getLegWeeklyNormalizedYieldPct(leg, candidate, options = {}) {
  const { allowParentCandidateFallback = false } = options;

  const directNorm = normalizeWeeklyYieldPctReading(leg?.weeklyNormalizedYield);
  if (directNorm != null) return directNorm;

  if (allowParentCandidateFallback) {
    const parentNorm = normalizeWeeklyYieldPctReading(candidate?.weeklyNormalizedYield);
    if (parentNorm != null) return parentNorm;
  }

  const dte = resolveLegDte(leg, candidate);
  const periodPct = getLegPeriodYieldPct(leg, candidate);

  const fromPeriod = periodYieldPctToWeeklyNormalized(periodPct, dte);
  if (fromPeriod != null) return fromPeriod;

  if (hasExplicitInvalidDte(leg, candidate)) return null;

  // Legacy contrôlé : aucun champ DTE présent (fixtures historiques ≈ 7 DTE).
  if (isDteFieldUnset(leg, candidate) && periodPct != null) return periodPct;

  return null;
}

export function getLegDistancePct(leg) {
  const distance = Number(leg?.distancePct ?? NaN);
  return Number.isFinite(distance) ? distance : null;
}

export function getLegPopPct(leg) {
  const popDecimal = firstKnownOptionalPopDecimal(leg?.popProfitEstimated, leg?.popEstimate);
  return popDecimal == null ? null : popDecimal * 100;
}

function resolveKnownExecutionValue(candidates) {
  for (const candidate of candidates) {
    const rawValue = candidate?.value;
    if (rawValue == null || rawValue === "") continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      return { value, known: true, source: candidate.source };
    }
  }
  return { value: null, known: false, source: null };
}

/**
 * Liquidite d'execution de la jambe exacte, sans fallback vers une autre jambe.
 * Priorite canonique : champs jambe, objet liquidity, puis raw de cette meme jambe.
 */
export function resolveLegExecutionLiquidity(leg) {
  const volume = resolveKnownExecutionValue([
    { value: leg?.volume, source: "leg.volume" },
    { value: leg?.liquidity?.volume, source: "leg.liquidity.volume" },
    { value: leg?.raw?.volume, source: "leg.raw.volume" },
  ]);
  const openInterest = resolveKnownExecutionValue([
    { value: leg?.openInterest, source: "leg.openInterest" },
    { value: leg?.liquidity?.openInterest, source: "leg.liquidity.openInterest" },
    { value: leg?.raw?.openInterest, source: "leg.raw.openInterest" },
  ]);
  const liquiditySourceRaw =
    leg?.liquiditySource ??
    leg?.liquidity?.source ??
    leg?.quoteSource ??
    leg?.source ??
    null;
  const liquiditySource =
    liquiditySourceRaw == null || String(liquiditySourceRaw).trim() === ""
      ? null
      : String(liquiditySourceRaw).trim();

  return {
    volume: volume.value,
    openInterest: openInterest.value,
    volumeKnown: volume.known,
    openInterestKnown: openInterest.known,
    volumeSource: volume.source,
    openInterestSource: openInterest.source,
    liquiditySource,
  };
}

function resolveLegRawSpread(leg) {
  const explicit = resolveKnownExecutionValue([
    { value: leg?.spread, source: "leg.spread" },
    { value: leg?.liquidity?.spread, source: "leg.liquidity.spread" },
    { value: leg?.raw?.spread, source: "leg.raw.spread" },
  ]);
  if (explicit.known) return explicit.value;
  const book = legBidAskFinite(leg);
  return book.both && book.ask >= book.bid ? book.ask - book.bid : null;
}

/**
 * Score d'exécution pour une jambe option — même formule que computeProScore (wheelScanner).
 * Le score backend global est toujours calculé sur la jambe SAFE ; pour AGGRESSIVE il faut
 * recalculer sur la jambe bucket réellement sélectionnée.
 */
export function getLegExecutionBreakdown(leg) {
  if (!leg) return null;
  const spreadPct = getLegSpreadPct(leg);
  if (!Number.isFinite(spreadPct) || spreadPct < 0) return null;

  const executionLiquidity = resolveLegExecutionLiquidity(leg);
  const { volume, openInterest, volumeKnown, openInterestKnown } = executionLiquidity;
  const spreadScore = Math.max(0, 1 - spreadPct / 50);
  const volumeScore = volumeKnown && volume > 0 ? Math.min(volume / 200, 1) : 0;
  const openInterestScore =
    openInterestKnown && openInterest > 0 ? Math.min(openInterest / 500, 1) : 0;
  const rawExecutionScore =
    spreadScore * 0.5 + volumeScore * 0.3 + openInterestScore * 0.2;
  const executionScore = Math.max(0, Math.min(1, rawExecutionScore));

  return {
    executionScore,
    spreadScore,
    volumeScore,
    openInterestScore,
    spread: resolveLegRawSpread(leg),
    spreadPct,
    volume,
    openInterest,
    spreadKnown: true,
    volumeKnown,
    openInterestKnown,
    executionDataComplete: volumeKnown && openInterestKnown,
    volumeSource: executionLiquidity.volumeSource,
    openInterestSource: executionLiquidity.openInterestSource,
    legSource: leg?.source ?? null,
    liquiditySource: executionLiquidity.liquiditySource,
    formula: "spreadScore*0.5 + volumeScore*0.3 + openInterestScore*0.2",
  };
}

export function getLegExecutionScore(leg) {
  const breakdown = getLegExecutionBreakdown(leg);
  return breakdown?.executionScore ?? null;
}

/** Score d'exécution contextualisé à la jambe bucket (ou selectedLeg si absent). */
export function getCandidateExecutionScore(candidate, leg = null) {
  const targetLeg = leg ?? candidate?.selectedLeg ?? null;
  const legScore = getLegExecutionScore(targetLeg);
  if (legScore != null && Number.isFinite(legScore)) return legScore;
  const pro = Number(candidate?.proExecutionScore);
  return Number.isFinite(pro) ? pro : null;
}

function roundProScore(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function pickFiniteProScore(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Distance scanner : decimal abs (ex. 0.101 pour 10,1 %). Jambe dashboard : souvent en %. */
function normalizeDistancePctToScannerDecimal(distancePctRaw) {
  const abs = Math.abs(Number(distancePctRaw));
  if (!Number.isFinite(abs)) return null;
  return abs > 1 ? abs / 100 : abs;
}

/** Rendement hebdomadaire normalisé en decimal pour proScore (ex. 0.00607 = 0,607 %/sem). */
function getLegWeeklyYieldDecimalForProScore(leg, candidate) {
  const yieldPct = getLegWeeklyNormalizedYieldPct(leg, candidate, {
    allowParentCandidateFallback: true,
  });
  if (!Number.isFinite(yieldPct) || yieldPct <= 0) return null;
  return yieldPct / 100;
}

export function computeLegProDistanceScore(leg, candidate = null) {
  if (!leg) return null;
  const explicit = pickFiniteProScore(leg?.proDistanceScore);
  if (explicit != null) return explicit;
  const distancePctRaw = getLegDistancePct(leg);
  if (distancePctRaw == null || !Number.isFinite(Number(distancePctRaw))) return null;
  const distanceDecimal = normalizeDistancePctToScannerDecimal(distancePctRaw);
  if (distanceDecimal == null) return null;
  return roundProScore(Math.min(distanceDecimal / 0.1, 1));
}

/**
 * Formule identique à wheelScanner.computeProScore (l.372-394).
 * Unités : weeklyYield decimal, distance decimal abs, spread/volume/OI comme getLegExecutionBreakdown.
 */
export function computeLegProFinalScore(leg, candidate, executionScore, distanceScore) {
  const explicit = pickFiniteProScore(leg?.proFinalScore);
  if (explicit != null) return explicit;
  const weeklyYield = getLegWeeklyYieldDecimalForProScore(leg, candidate);
  const exec = pickFiniteProScore(executionScore);
  const dist = pickFiniteProScore(distanceScore);
  if (weeklyYield == null || exec == null || dist == null) return null;
  return roundProScore(weeklyYield * exec * dist);
}

export function resolveSelectedLegMode(candidate, selectedLeg = null) {
  const leg = selectedLeg ?? candidate?.selectedLeg ?? null;
  const explicit = String(
    candidate?.selectedLegMode ?? candidate?._bucketSelectedMode ?? ""
  ).trim().toUpperCase();
  if (explicit) return explicit;
  const safe = candidate?._safeLeg ?? candidate?.safeStrike ?? null;
  const agg = candidate?._aggLeg ?? candidate?.aggressiveStrike ?? null;
  if (leg && safe && Number(leg.strike) === Number(safe.strike)) return "SAFE";
  if (leg && agg && Number(leg.strike) === Number(agg.strike)) return "AGGRESSIVE";
  return "";
}

function canUseParentProScoreFallback(candidate, selectedMode) {
  if (String(selectedMode || "").toUpperCase() === "SAFE") return true;
  if (!candidate?.selectedLeg && !candidate?.safeStrike && !candidate?.aggressiveStrike) return true;
  return false;
}

/**
 * AF-12 — Scores professionnels de la jambe réellement sélectionnée.
 * Priorité : explicit leg → recalcul jambe → parent (SAFE/legacy seulement) → neutre 0.
 */
export function resolveSelectedLegProScore(candidate, options = {}) {
  const selectedLeg = options.selectedLeg ?? candidate?.selectedLeg ?? null;
  const selectedMode = resolveSelectedLegMode(candidate, selectedLeg);
  const parentFallbackOk = canUseParentProScoreFallback(candidate, selectedMode);

  const executionExplicit = pickFiniteProScore(selectedLeg?.proExecutionScore);
  const executionRecomputed = getLegExecutionScore(selectedLeg);
  let proExecutionScore = executionExplicit ?? executionRecomputed;
  let proExecutionSource = executionExplicit != null
    ? "selected_leg_explicit"
    : executionRecomputed != null
      ? "selected_leg_recomputed"
      : null;
  if (proExecutionScore == null) {
    const parentExec = pickFiniteProScore(candidate?.proExecutionScore);
    if (parentFallbackOk && parentExec != null) {
      proExecutionScore = parentExec;
      proExecutionSource = "safe_parent_legacy";
    } else {
      proExecutionScore = 0;
      proExecutionSource = "neutral_fallback";
    }
  }

  const distanceExplicit = pickFiniteProScore(selectedLeg?.proDistanceScore);
  const distanceRecomputed = computeLegProDistanceScore(selectedLeg, candidate);
  let proDistanceScore = distanceExplicit ?? distanceRecomputed;
  let proDistanceSource = distanceExplicit != null
    ? "selected_leg_explicit"
    : distanceRecomputed != null
      ? "selected_leg_recomputed"
      : null;
  if (proDistanceScore == null) {
    const parentDist = pickFiniteProScore(candidate?.proDistanceScore);
    if (parentFallbackOk && parentDist != null) {
      proDistanceScore = parentDist;
      proDistanceSource = "safe_parent_legacy";
    } else {
      proDistanceScore = 0;
      proDistanceSource = "neutral_fallback";
    }
  }

  const finalExplicit = pickFiniteProScore(selectedLeg?.proFinalScore);
  const finalRecomputed = computeLegProFinalScore(
    selectedLeg,
    candidate,
    proExecutionScore,
    proDistanceScore
  );
  let proFinalScore = finalExplicit ?? finalRecomputed;
  let proFinalSource = finalExplicit != null
    ? "selected_leg_explicit"
    : finalRecomputed != null
      ? "selected_leg_recomputed"
      : null;
  if (proFinalScore == null) {
    const parentFinal = pickFiniteProScore(candidate?.proFinalScore);
    if (parentFallbackOk && parentFinal != null) {
      proFinalScore = parentFinal;
      proFinalSource = "safe_parent_legacy";
    } else {
      proFinalScore = 0;
      proFinalSource = "neutral_fallback";
    }
  }

  const proScoreSource =
    proFinalSource === "selected_leg_explicit" ||
    proDistanceSource === "selected_leg_explicit" ||
    proExecutionSource === "selected_leg_explicit"
      ? "selected_leg_explicit"
      : proFinalSource === "selected_leg_recomputed" ||
          proDistanceSource === "selected_leg_recomputed" ||
          proExecutionSource === "selected_leg_recomputed"
        ? "selected_leg_recomputed"
        : proFinalSource === "safe_parent_legacy"
          ? "safe_parent_legacy"
          : "neutral_fallback";

  return {
    proFinalScore: roundProScore(proFinalScore),
    proExecutionScore: roundProScore(proExecutionScore),
    proDistanceScore: roundProScore(proDistanceScore),
    proScoreSource,
    proFinalSource,
    proExecutionSource,
    proDistanceSource,
    selectedLegMode: selectedMode || null,
  };
}

function pickMetadataString(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

function pickMetadataNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/** AF-15 — Projection des métadonnées d'audit depuis selectedLeg (lecture seule). */
export function projectSelectedLegMetadata(candidate) {
  const leg = candidate?.selectedLeg ?? null;
  const parentExpiration = pickMetadataString(
    candidate?.targetExpiration,
    candidate?.selectedExpiration,
    candidate?.expiration,
    candidate?.optionsExpiration
  );
  const legExpiration = pickMetadataString(
    leg?.expiration,
    leg?.targetExpiration,
    leg?.selectedExpiration
  );
  const expiration = legExpiration ?? parentExpiration ?? null;
  const parentDte = pickMetadataNumber(candidate?.dteDays, candidate?.dteAtScan, candidate?.dte);
  const dte = pickMetadataNumber(leg?.dte, leg?.dteDays, parentDte);

  return {
    expiration,
    expirationSource: legExpiration ? "selectedLeg" : parentExpiration ? "parent" : null,
    expirationMismatch: !!(
      legExpiration &&
      parentExpiration &&
      String(legExpiration) !== String(parentExpiration)
    ),
    dte,
    bid: pickMetadataNumber(leg?.bid, candidate?.bid),
    ask: pickMetadataNumber(leg?.ask, candidate?.ask),
    mid: pickMetadataNumber(leg?.mid, candidate?.mid),
    rank: pickMetadataNumber(leg?.rank, candidate?.rank, candidate?.finalRank),
    finalRank: pickMetadataNumber(leg?.finalRank, candidate?.finalRank),
    optionSymbol: pickMetadataString(leg?.optionSymbol, leg?.contractSymbol),
    conId: pickMetadataNumber(leg?.conId),
    contractId: pickMetadataNumber(leg?.contractId, leg?.conId),
    quoteTimestamp: pickMetadataString(leg?.quoteTimestamp, leg?.quoteTime),
    marketDataType: pickMetadataString(leg?.marketDataType, leg?.marketDataTypeRaw),
    quoteSource: pickMetadataString(leg?.quoteSource, candidate?.quoteSource),
  };
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
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(max) || max <= 0) return 0;
  return clamp01((max - value) / max);
}

export function buildCapitalComboPoolStats(candidates) {
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

export function buildCapitalComboScoreBreakdown(candidate, mode, usableCapital, poolStats) {
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
  const safePeriodYieldPct = getLegPeriodYieldPct(safeLeg, candidate);
  const safeYieldPct = getLegWeeklyNormalizedYieldPct(safeLeg, candidate);
  const safeDistancePct = getLegDistancePct(safeLeg);
  const safePopDecimal = firstKnownOptionalPopDecimal(
    safeLeg?.popProfitEstimated,
    safeLeg?.popEstimate,
  );
  const safePopPct = safePopDecimal == null ? null : safePopDecimal * 100;
  const safeCapital = Number.isFinite(safeStrikeValue) && safeStrikeValue > 0 ? safeStrikeValue * 100 : 0;
  const safeGrade = String(candidate?.safeGrade ?? "").toUpperCase() || null;

  const aggStrikeValue = Number(aggLeg?.strike ?? NaN);
  const aggPremium = getLegPremiumValue(aggLeg);
  const aggSpreadPct = getLegSpreadPct(aggLeg);
  const aggPeriodYieldPct = getLegPeriodYieldPct(aggLeg, candidate);
  const aggYieldPct = getLegWeeklyNormalizedYieldPct(aggLeg, candidate);
  const aggDistancePct = getLegDistancePct(aggLeg);
  const aggPopDecimal = firstKnownOptionalPopDecimal(
    aggLeg?.popProfitEstimated,
    aggLeg?.popEstimate,
  );
  const aggPopPct = aggPopDecimal == null ? null : aggPopDecimal * 100;
  const aggCapital = Number.isFinite(aggStrikeValue) && aggStrikeValue > 0 ? aggStrikeValue * 100 : 0;
  // Derive grade from actual leg yield (bid/strike fallback) — avoids weeklyYield=0 giving "WATCH"
  const _aggDerivedGrade = gradeLeg({
    spreadPct: aggSpreadPct,
    weeklyYieldPct: aggPeriodYieldPct,
    popDecimal: aggPopDecimal,
  });
  const _aggStoredGrade = String(candidate?.aggressiveGrade ?? "").toUpperCase() || null;
  const aggGrade =
    getAggressivePriorityGrade({
      spreadPct: aggSpreadPct,
      weeklyYieldPct: aggPeriodYieldPct,
      popDecimal: aggPopDecimal,
      distancePct: aggDistancePct,
    }) ??
    (_aggDerivedGrade !== "REJECT" ? _aggDerivedGrade : null) ??
    _aggStoredGrade;

  const hasSafeLegValid = !!safeLeg &&
    Number.isFinite(safeStrikeValue) && safeStrikeValue > 0 &&
    Number.isFinite(safePremium) && safePremium > 0 &&
    Number.isFinite(safeSpreadPct) && safeSpreadPct >= 0 && safeSpreadPct <= 35 &&
    Number.isFinite(safePeriodYieldPct) && safePeriodYieldPct > 0 &&
    Number.isFinite(safeYieldPct) && safeYieldPct > 0;

  const hasAggLegValid = !!aggLeg &&
    Number.isFinite(aggStrikeValue) && aggStrikeValue > 0 &&
    Number.isFinite(aggPremium) && aggPremium > 0 &&
    Number.isFinite(aggSpreadPct) && aggSpreadPct >= 0 && aggSpreadPct <= 35 &&
    Number.isFinite(aggPeriodYieldPct) && aggPeriodYieldPct > 0 &&
    Number.isFinite(aggYieldPct) && aggYieldPct > 0;

  const commonBlocked =
    (meta.isCryptoBlocked && !meta.isCryptoAllowed) ||
    meta.qualityTier === "Inconnu à valider";

  // ─── Jambe globale (compat affichage compact principal) ──────────────────
  const selectedLeg = getFinalSelectedLeg(candidate);
  const strike = Number(selectedLeg?.strike ?? NaN);
  const premiumUnit = getLegPremiumValue(selectedLeg);
  const spreadPct = getLegSpreadPct(selectedLeg);
  const selectedPeriodYieldPct = getLegPeriodYieldPct(selectedLeg, candidate);
  const weeklyReturn = getLegWeeklyNormalizedYieldPct(selectedLeg, candidate, {
    allowParentCandidateFallback: true,
  });
  const distancePct = getLegDistancePct(selectedLeg);
  const popEstimate = getLegPopPct(selectedLeg);
  const capitalPerContract = Number.isFinite(strike) && strike > 0 ? strike * 100 : 0;
  const premiumPerContract =
    Number.isFinite(premiumUnit) && premiumUnit > 0 ? premiumUnit * 100 : 0;
  const gradeScore = getComboGradeScore(finalDisplayGrade);
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
    selectedPeriodYieldPct,
    periodYieldPct: selectedPeriodYieldPct,
    weeklyNormalizedYieldPct: weeklyReturn,
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
    _safePeriodYieldPct: safePeriodYieldPct,
    _aggPeriodYieldPct: aggPeriodYieldPct,
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
      weeklyReturn: selectedPeriodYieldPct ?? 0,
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

/**
 * Bande de sélection préférentielle de la jambe du bucket BALANCED (AF-07).
 * Rendements en points de pourcentage **PÉRIODE (jusqu'à expiration)**
 * (0,75 = 0,75 % jusqu'à expiration) ; min inclusif, max exclusif.
 * (Historique AF-17 : ces bornes s'appliquaient au rendement hebdomadaire
 * normalisé ; depuis le passage des bandes au rendement période, elles
 * s'appliquent au rendement période — valeurs numériques inchangées.)
 */
export const BALANCED_PREFERRED_LEG_YIELD_BAND = Object.freeze({
  minInclusivePct: 0.75,
  maxExclusivePct: 1.05,
  midTargetPct: 0.875,
});

export function getScaledBalancedPreferredLegYieldBand(dteDays) {
  const dte = Number(dteDays);
  if (!isValidComboDte(dte)) return BALANCED_PREFERRED_LEG_YIELD_BAND;
  const factor = dte > 7 ? dte / 7 : 1;
  return Object.freeze({
    minInclusivePct: BALANCED_PREFERRED_LEG_YIELD_BAND.minInclusivePct * factor,
    maxExclusivePct: BALANCED_PREFERRED_LEG_YIELD_BAND.maxExclusivePct * factor,
    midTargetPct: BALANCED_PREFERRED_LEG_YIELD_BAND.midTargetPct * factor,
  });
}

/**
 * AF-07 — résolution générique de la jambe d'un bucket parmi une liste ordonnée
 * de jambes candidates. Chaque jambe est évaluée selon ses propres données :
 * une jambe invalide ou hors bande n'empêche jamais d'essayer la suivante.
 * Ne modifie aucun objet, ne recalcule aucune jambe.
 *
 * Descripteur attendu : { mode, leg, yieldPct, strikeValue, capital, grade,
 * valid, priority }. `priority` (défaut 0, croissant) sépare les groupes :
 * une jambe conforme du groupe le plus prioritaire gagne avant toute jambe
 * d'un groupe suivant — prévu pour la future vraie jambe BALANCED (priority 0)
 * devant les fallbacks SAFE/AGGRESSIVE (priority 1), sans réécrire cette logique.
 *
 * Règles au sein d'un groupe (héritées de l'ancienne logique inline, inchangées) :
 * 1. seule une jambe conforme à la bande effective [minYieldPctInclusive,
 *    maxYieldPctExclusive) est retenue — min inclusif, max exclusif, max null =
 *    pas de plafond ; rendement inconnu (null/undefined/NaN) = non conforme ;
 * 2. si `preferredBand` est fournie et qu'au moins une jambe conforme est dans
 *    la bande préférée : la plus proche de midTargetPct gagne ; à égalité
 *    exacte de distance, la jambe listée en DERNIER gagne (reproduit la règle
 *    « <= » historique qui favorisait SAFE face à AGGRESSIVE) ;
 * 3. sinon : première jambe conforme dans l'ordre de la liste (ordre de
 *    fallback métier existant : AGGRESSIVE avant SAFE).
 *
 * Retourne le descripteur choisi, ou null si AUCUNE jambe n'est conforme —
 * l'appelant décide alors du comportement de rejet (aucune jambe hors bande
 * n'est forcée ici).
 */
export function resolveCompatibleLegForMode({
  legCandidates,
  minYieldPctInclusive,
  maxYieldPctExclusive,
  preferredBand = null,
  yieldPolicyMode = null,
  candidateForDte = null,
}) {
  const list = Array.isArray(legCandidates) ? legCandidates : [];
  const usable = list.filter(
    (d) => d && typeof d === "object" && d.valid === true && d.leg != null,
  );
  if (!usable.length) return null;

  const min = Number(minYieldPctInclusive);
  const max = maxYieldPctExclusive == null ? null : Number(maxYieldPctExclusive);
  const balancedYieldIsInformational =
    normalizeYieldPolicyMode(yieldPolicyMode) === "BALANCED";
  const resolveBandForDescriptor = (d) => {
    if (yieldPolicyMode) {
      const dte = resolveLegDte(d.leg, candidateForDte);
      if (!isValidComboDte(dte)) return null;
      return getCanonicalPeriodYieldBand(yieldPolicyMode, dte);
    }
    return {
      effectivePeriodMinPct: min,
      effectivePeriodMaxPct: max,
    };
  };
  const conformsToBand = (d) => {
    const y = Number(d.yieldPct);
    if (!Number.isFinite(y)) return false;
    if (balancedYieldIsInformational) return true;
    const band = resolveBandForDescriptor(d);
    if (!band) return false;
    return isPeriodYieldAdmissibleInBand(y, band);
  };
  const priorityOf = (d) => {
    const p = Number(d.priority);
    return Number.isFinite(p) ? p : 0;
  };

  const priorities = [...new Set(usable.map(priorityOf))].sort((a, b) => a - b);
  for (const priority of priorities) {
    const conforming = usable.filter((d) => priorityOf(d) === priority && conformsToBand(d));
    if (!conforming.length) continue;

    if (preferredBand && !balancedYieldIsInformational) {
      const pMin = Number(preferredBand.minInclusivePct);
      const pMax = Number(preferredBand.maxExclusivePct);
      const mid = Number(preferredBand.midTargetPct);
      const inPreferred = conforming.filter((d) => {
        const y = Number(d.yieldPct);
        let bandMin = pMin;
        let bandMax = pMax;
        let bandMid = mid;
        if (yieldPolicyMode) {
          const dte = resolveLegDte(d.leg, candidateForDte);
          if (!isValidComboDte(dte)) return false;
          const scaled = getScaledBalancedPreferredLegYieldBand(dte);
          bandMin = scaled.minInclusivePct;
          bandMax = scaled.maxExclusivePct;
          bandMid = scaled.midTargetPct;
        }
        return y >= bandMin && y < bandMax;
      });
      if (inPreferred.length) {
        let best = inPreferred[0];
        const bestMid = yieldPolicyMode
          ? getScaledBalancedPreferredLegYieldBand(resolveLegDte(best.leg, candidateForDte)).midTargetPct
          : mid;
        for (const d of inPreferred.slice(1)) {
          const dMid = yieldPolicyMode
            ? getScaledBalancedPreferredLegYieldBand(resolveLegDte(d.leg, candidateForDte)).midTargetPct
            : mid;
          if (Math.abs(Number(d.yieldPct) - dMid) <= Math.abs(Number(best.yieldPct) - bestMid)) best = d;
        }
        return best;
      }
    }
    return conforming[0];
  }
  return null;
}

export const BALANCED_LEG_SOURCES = Object.freeze({
  NATIVE: "BALANCED_NATIVE",
  FALLBACK_SAFE: "BALANCED_FALLBACK_SAFE",
  FALLBACK_AGGRESSIVE: "BALANCED_FALLBACK_AGGRESSIVE",
  UNAVAILABLE: "BALANCED_UNAVAILABLE",
});

export const BALANCED_NATIVE_REASON_CODES = Object.freeze({
  SELECTED: "NATIVE_BALANCED_SELECTED",
  SAFE_MISSING: "SAFE_LEG_MISSING",
  AGGRESSIVE_MISSING: "AGGRESSIVE_LEG_MISSING",
  EXPIRATION_MISMATCH: "SAFE_AGGRESSIVE_EXPIRATION_MISMATCH",
  CHAIN_MISSING: "MISSING_CHAIN_DATA_FOR_NATIVE_BALANCED",
  NO_INTERMEDIATE_STRIKE: "NO_STRIKE_STRICTLY_BETWEEN",
  INTERMEDIATE_FOUND: "INTERMEDIATE_CONTRACTS_FOUND",
  QUOTES_INVALID: "INTERMEDIATE_QUOTES_INVALID",
  BELOW_MIN: "INTERMEDIATE_STRIKES_BELOW_BALANCED_MIN",
  ABOVE_MAX: "INTERMEDIATE_STRIKES_ABOVE_BALANCED_MAX",
  OUTSIDE_YIELD_BAND: "INTERMEDIATE_STRIKES_OUTSIDE_BALANCED_YIELD_BAND",
  ALL_YIELDS_OUTSIDE_TARGET_BAND: "ALL_INTERMEDIATE_YIELDS_OUTSIDE_TARGET_BAND",
  FAILED_SPREAD: "INTERMEDIATE_STRIKES_FAILED_SPREAD",
  FAILED_LIQUIDITY: "INTERMEDIATE_STRIKES_FAILED_LIQUIDITY",
  FAILED_GRADE: "INTERMEDIATE_STRIKES_FAILED_GRADE",
  FAILED_STATIC_FILTERS: "INTERMEDIATE_STRIKES_FAILED_STATIC_FILTERS",
  NONE_ELIGIBLE: "NO_NATIVE_BALANCED_CONTRACT_ELIGIBLE",
  FALLBACK_SAFE: "FALLBACK_SAFE_SELECTED",
  FALLBACK_AGGRESSIVE: "FALLBACK_AGGRESSIVE_SELECTED",
  NO_FALLBACK: "NO_BALANCED_FALLBACK_ELIGIBLE",
  INVALID_DTE: "MISSING_OR_INVALID_DTE_FOR_YIELD_POLICY",
  EQUAL_BOUNDARIES: "SAFE_AGGRESSIVE_STRIKES_EQUAL",
  INVERTED_BOUNDARIES: "SAFE_AGGRESSIVE_STRIKE_ORDER_INVERTED",
});

/** Limite réellement appliquée par BALANCED Institutional V3. */
export const BALANCED_EFFECTIVE_MAX_SPREAD_PCT = 20;

function balancedExpirationKey(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const compact = text.replace(/-/g, "");
  return /^\d{8}$/.test(compact) ? compact : text;
}

function resolveBalancedChainInput(candidate, explicitChain) {
  if (Array.isArray(explicitChain)) {
    return { available: true, rows: explicitChain, source: "explicit" };
  }
  const ibkrRows = candidate?.ibkrDirect?.putCandidates ?? candidate?.ibkrDirect?.raw?.putCandidates;
  if (Array.isArray(ibkrRows)) {
    return { available: true, rows: ibkrRows, source: "ibkr_putCandidates" };
  }
  if (Array.isArray(candidate?.balancedPutCandidates)) {
    return { available: true, rows: candidate.balancedPutCandidates, source: "balancedPutCandidates" };
  }
  if (candidate?.balancedPutChainAvailable === true) {
    return { available: true, rows: [], source: "balancedPutCandidates" };
  }
  if (Array.isArray(candidate?.putCandidates)) {
    return { available: true, rows: candidate.putCandidates, source: "putCandidates" };
  }
  if (Array.isArray(candidate?.raw?.balancedPutCandidates)) {
    return { available: true, rows: candidate.raw.balancedPutCandidates, source: "raw.balancedPutCandidates" };
  }
  if (Array.isArray(candidate?.raw?.putCandidates)) {
    return { available: true, rows: candidate.raw.putCandidates, source: "raw.putCandidates" };
  }
  const optionPuts = candidate?.optionChain?.puts ?? candidate?.raw?.optionChain?.puts;
  if (Array.isArray(optionPuts)) {
    return { available: true, rows: optionPuts, source: "optionChain.puts" };
  }
  return { available: false, rows: [], source: null };
}

/** Type d'option canonique : `P`/`PUT` => "PUT", `C`/`CALL` => "CALL". */
function balancedOptionRightKey(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim().toUpperCase();
    if (!text) continue;
    if (text === "P" || text === "PUT") return "PUT";
    if (text === "C" || text === "CALL") return "CALL";
  }
  return null;
}

/** Ticker canonique — `ticker` et `symbol` sont interchangeables selon la source. */
function balancedTickerKey(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim().toUpperCase();
    if (text) return text;
  }
  return null;
}

function resolveBalancedContractExpiration(row, candidate, chainSource) {
  return (
    row?.expiration ??
    row?.targetExpiration ??
    (chainSource === "ibkr_putCandidates"
      ? candidate?.ibkrDirect?.expiration ?? candidate?.ibkrDirect?.raw?.expiration
      : null) ??
    candidate?.targetExpiration ??
    candidate?.selectedExpiration ??
    candidate?.expiration ??
    null
  );
}

/**
 * POP canonique d'un contrat BALANCED intermédiaire réel.
 *
 * Transport strict, jamais synthétique :
 *  1. POP déjà portée par le contrat réel (`popProfitEstimated` / `popEstimate`).
 *     C'est le cas nominal en live : `mergeIbkrIntoDashboardCandidate` enrichit
 *     chaque put de la chaîne IBKR avec la POP de SON propre contrat, via la même
 *     fonction canonique que SAFE/AGGRESSIVE ;
 *  2. sinon, POP calculée par le scanner Yahoo pour le MÊME contrat économique via
 *     la chaîne enrichie (`balancedPutCandidates`).
 *
 * L'appariement (2) est canonique et jamais opportuniste : même ticker, même
 * expiration (compacte ou ISO), même strike numérique, même PUT. `localSymbol` et
 * `optionSymbol` ne sont jamais exigés — les deux sources les formatent
 * différemment. Une POP inconnue reste `null` (jamais 0, jamais recopiée depuis
 * SAFE ou AGGRESSIVE).
 */
function resolveRealBalancedLegPop(row, candidate, chainSource) {
  const unmatched = (popMatchReason) => ({
    popDecimal: null,
    popSource: null,
    popMatchStatus: "unmatched",
    popMatchSource: null,
    popMatchReason,
  });
  const direct = firstKnownOptionalPopDecimal(row?.popProfitEstimated, row?.popEstimate);
  if (direct != null) {
    return {
      popDecimal: direct,
      popSource: pickMetadataString(row?.popSource) ?? "contract",
      popMatchStatus: "matched",
      popMatchSource: "contract",
      popMatchReason: "pop_present_on_contract",
    };
  }
  const strike = Number(row?.strike);
  if (!Number.isFinite(strike)) return unmatched("invalid_strike");
  const rowRight = balancedOptionRightKey(row?.right, row?.optionType) ?? "PUT";
  if (rowRight !== "PUT") return unmatched("row_not_a_put");
  const rowTicker = balancedTickerKey(
    row?.ticker,
    row?.symbol,
    candidate?.ticker,
    candidate?.symbol,
  );
  const rowExpiration = balancedExpirationKey(
    resolveBalancedContractExpiration(row, candidate, chainSource),
  );
  const enrichedLists = [
    candidate?.balancedPutCandidates,
    candidate?.raw?.balancedPutCandidates,
  ];
  let sawSameContract = false;
  for (const list of enrichedLists) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (Number(entry?.strike) !== strike) continue;
      if ((balancedOptionRightKey(entry?.right, entry?.optionType) ?? "PUT") !== "PUT") continue;
      const entryTicker = balancedTickerKey(entry?.ticker, entry?.symbol);
      if (rowTicker && entryTicker && rowTicker !== entryTicker) continue;
      const entryExpiration = balancedExpirationKey(entry?.expiration ?? entry?.targetExpiration);
      if (rowExpiration && entryExpiration && rowExpiration !== entryExpiration) continue;
      sawSameContract = true;
      const matched = firstKnownOptionalPopDecimal(entry?.popProfitEstimated, entry?.popEstimate);
      if (matched != null) {
        return {
          popDecimal: matched,
          popSource: pickMetadataString(entry?.popSource) ?? "scanner_balanced_chain",
          popMatchStatus: "matched",
          popMatchSource: "scanner_balanced_chain",
          popMatchReason: "enriched_contract_matched",
        };
      }
    }
  }
  return unmatched(sawSameContract ? "enriched_contract_without_pop" : "no_enriched_contract");
}

function normalizeRealBalancedPutLeg(row, candidate, chainSource) {
  if (!row || typeof row !== "object") return null;
  const strike = Number(row.strike);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const bid = row.bid == null || row.bid === "" ? null : Number(row.bid);
  const ask = row.ask == null || row.ask === "" ? null : Number(row.ask);
  const explicitMid = row.mid == null || row.mid === "" ? null : Number(row.mid);
  const mid =
    Number.isFinite(explicitMid) && explicitMid > 0
      ? explicitMid
      : Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask >= bid
        ? (bid + ask) / 2
        : null;
  const ticker = String(
    row.ticker ?? row.symbol ?? candidate?.ticker ?? candidate?.symbol ?? "",
  ).trim().toUpperCase();
  const expiration = resolveBalancedContractExpiration(row, candidate, chainSource);
  const spot = Number(candidate?.price ?? candidate?.currentPrice ?? candidate?.underlyingPrice);
  const distancePct =
    Number.isFinite(Number(row.distancePct)) &&
    Math.abs(Number(row.distancePct)) > 1
      ? Number(row.distancePct)
      : Number.isFinite(spot) && spot > 0
        ? ((strike - spot) / spot) * 100
        : Number.isFinite(Number(row.distancePct))
          ? Number(row.distancePct)
          : null;
  const optionSymbol =
    pickMetadataString(row.optionSymbol, row.contractSymbol, row.localSymbol) ?? null;
  const source =
    chainSource === "ibkr_putCandidates"
      ? "IBKR live"
      : pickMetadataString(row.source, candidate?.optionsSource, "Yahoo");
  // POP canonique du contrat réel — transportée explicitement pour ne jamais
  // être perdue (chaîne IBKR brute sans POP) ni synthétisée depuis SAFE/AGG.
  const {
    popDecimal: legPopDecimal,
    popSource: legPopSource,
    popMatchStatus,
    popMatchSource,
    popMatchReason,
  } = resolveRealBalancedLegPop(row, candidate, chainSource);
  return {
    ...row,
    ticker,
    symbol: ticker,
    expiration,
    right: String(row.right ?? row.optionType ?? "PUT").trim().toUpperCase(),
    optionType: String(row.optionType ?? row.right ?? "PUT").trim().toUpperCase(),
    strike,
    // Représentation POP canonique : `popProfitEstimated`/`popEstimate` restent
    // lus par getLegPopPct et la carte ; `popDecimal`/`popPct`/`popSource`
    // exposent la même valeur sous forme explicite. Inconnue => null (jamais 0).
    popProfitEstimated: legPopDecimal,
    popEstimate: legPopDecimal,
    popDecimal: legPopDecimal,
    popPct: legPopDecimal == null ? null : legPopDecimal * 100,
    popSource: legPopDecimal == null ? null : legPopSource,
    // Diagnostics d'appariement — internes, jamais rendus dans l'interface.
    popMatchStatus,
    popMatchSource,
    popMatchReason,
    bid: Number.isFinite(bid) ? bid : null,
    ask: Number.isFinite(ask) ? ask : null,
    mid,
    premium: Number.isFinite(bid) && bid > 0 ? bid : null,
    premiumUsed: Number.isFinite(bid) && bid > 0 ? bid : null,
    primeUsed: Number.isFinite(bid) && bid > 0 ? bid : null,
    distancePct,
    dteDays: resolveLegDte(row, candidate),
    optionSymbol,
    contractSymbol: pickMetadataString(row.contractSymbol, optionSymbol),
    conId: pickMetadataNumber(row.conId),
    contractId: pickMetadataNumber(row.contractId, row.conId),
    quoteTimestamp: pickMetadataString(
      row.quoteTimestamp,
      row.quoteTime,
      candidate?.ibkrDirect?.scanCompletedAt,
    ),
    marketDataType: pickMetadataString(
      row.marketDataType,
      row.marketDataTypeRaw,
      candidate?.ibkrDirect?.marketDataTypeReceivedLabel,
    ),
    quoteSource: pickMetadataString(
      row.quoteSource,
      chainSource === "ibkr_putCandidates" ? "IBKR" : "Yahoo",
    ),
    source,
    raw: row.raw ?? row,
  };
}

function evaluateBalancedLegEligibility({
  leg,
  candidate,
  band,
  maxSpreadPct,
  requireRealQuote = true,
  explicitGrade = null,
}) {
  const bid = Number(leg?.bid);
  const ask = Number(leg?.ask);
  const mid = Number(leg?.mid);
  const quoteValid =
    !requireRealQuote ||
    (Number.isFinite(bid) &&
      bid > 0 &&
      Number.isFinite(ask) &&
      ask > 0 &&
      ask >= bid &&
      Number.isFinite(mid) &&
      mid > 0);
  const periodYieldPct = quoteValid ? getLegPeriodYieldPct(leg, candidate) : null;
  const weeklyNormalizedYieldPct = quoteValid
    ? getLegWeeklyNormalizedYieldPct(leg, candidate)
    : null;
  const yieldBandStatus = quoteValid
    ? getBalancedYieldBandStatus(periodYieldPct, band)
    : null;
  // Compat diagnostic : "yieldEligible" signifie desormais uniquement
  // "dans la cible". Il ne participe plus a l'admissibilite d'execution.
  const yieldEligible = quoteValid && yieldBandStatus === "WITHIN";
  const spreadPct = quoteValid ? getLegSpreadPct(leg) : null;
  const spreadEligible =
    quoteValid &&
    Number.isFinite(spreadPct) &&
    spreadPct >= 0 &&
    spreadPct <= maxSpreadPct;
  const executionBreakdown = spreadEligible ? getLegExecutionBreakdown(leg) : null;
  const executionScore = executionBreakdown?.executionScore ?? null;
  // BALANCED n'a pas de seuil OI/volume additionnel dans ce moteur. Les
  // metriques existantes restent requises par le score d'execution et servent
  // au departage, sans creer un nouveau seuil.
  const liquidityEligible = spreadEligible && executionBreakdown != null;
  const grade = spreadEligible
    ? resolveSelectedLegGrade({
        explicitGrade: explicitGrade ?? leg?.grade,
        selectedLeg: leg,
        selectedMode: "BALANCED",
        candidate,
      })
    : null;
  const popPct = getLegPopPct(leg);
  const distancePct = getLegDistancePct(leg);
  const watchEligible =
    grade === "WATCH" &&
    popPct != null &&
    popPct >= 88 &&
    spreadPct <= 15 &&
    distancePct != null &&
    distancePct <= -6;
  const gradeEligible = liquidityEligible && (grade === "A" || grade === "B" || watchEligible);
  const meta = candidate?._tickerMeta ?? getTickerDisplayMeta(
    String(candidate?.ticker ?? candidate?.symbol ?? "").trim().toUpperCase(),
  );
  const qualityOverlay = gradeEligible
    ? computeTickerQualityOverlay({
        ...candidate,
        selectedLeg: leg,
        selectedSpreadPct: spreadPct,
        selectedYieldPct: weeklyNormalizedYieldPct,
        selectedPeriodYieldPct: periodYieldPct,
        selectedDistancePct: distancePct,
        _popForCombo: popPct,
      })
    : null;
  const commonBlocked =
    (meta?.isCryptoBlocked && !meta?.isCryptoAllowed) ||
    meta?.qualityTier === "Inconnu à valider";
  const qualityBlocked =
    qualityOverlay?.qualityTier === "avoid" ||
    (qualityOverlay?.qualityTier === "speculative" &&
      (popPct == null ||
        popPct < 82 ||
        (spreadPct != null && spreadPct > 20)));
  const executionEligible = liquidityEligible;
  const fullyEligible = gradeEligible && !commonBlocked && !qualityBlocked;
  const pro = fullyEligible
    ? resolveSelectedLegProScore(
        { ...candidate, selectedLeg: leg, selectedLegMode: "BALANCED" },
        { selectedLeg: leg, selectedMode: "BALANCED" },
      )
    : null;
  return {
    leg,
    quoteValid,
    periodYieldPct,
    weeklyNormalizedYieldPct,
    yieldBandStatus,
    yieldEligible,
    spreadPct,
    spreadEligible,
    executionBreakdown,
    executionScore,
    liquidityEligible,
    grade,
    gradeEligible,
    qualityOverlay,
    fullyEligible,
    executionEligible,
    rejectionReasons: [
      ...(!quoteValid ? ["INVALID_QUOTE"] : []),
      ...(quoteValid && !spreadEligible ? ["SPREAD_NOT_ELIGIBLE"] : []),
      ...(spreadEligible && !liquidityEligible ? ["LIQUIDITY_NOT_ELIGIBLE"] : []),
      ...(liquidityEligible && !gradeEligible ? ["GRADE_NOT_ELIGIBLE"] : []),
      ...(gradeEligible && (commonBlocked || qualityBlocked) ? ["STATIC_FILTER_NOT_ELIGIBLE"] : []),
    ],
    score: pro?.proFinalScore ?? 0,
  };
}

function compareBalancedEvaluationsByMidpoint(a, b, midpointStrike) {
  const distanceA = Math.abs(a.leg.strike - midpointStrike);
  const distanceB = Math.abs(b.leg.strike - midpointStrike);
  const spreadA = Number.isFinite(a.spreadPct) ? a.spreadPct : Number.POSITIVE_INFINITY;
  const spreadB = Number.isFinite(b.spreadPct) ? b.spreadPct : Number.POSITIVE_INFINITY;
  const liquidityA = Number.isFinite(a.executionScore) ? a.executionScore : -1;
  const liquidityB = Number.isFinite(b.executionScore) ? b.executionScore : -1;
  const spreadDelta = spreadA - spreadB;
  const liquidityDelta = liquidityB - liquidityA;
  const keyA = String(a.leg.optionSymbol ?? a.leg.conId ?? "");
  const keyB = String(b.leg.optionSymbol ?? b.leg.conId ?? "");
  return (
    distanceA - distanceB ||
    (Math.abs(spreadDelta) > 1e-9 ? spreadDelta : 0) ||
    (Math.abs(liquidityDelta) > 1e-12 ? liquidityDelta : 0) ||
    a.leg.strike - b.leg.strike ||
    keyA.localeCompare(keyB)
  );
}

function balancedNativeBaseResult({
  source = BALANCED_LEG_SOURCES.UNAVAILABLE,
  status = "unavailable",
  reasonCode,
  reasonCodes = [],
  safeStrike = null,
  aggressiveStrike = null,
  lowerBoundaryStrike = null,
  upperBoundaryStrike = null,
  midpointStrike = null,
  dteDays = null,
  band = null,
  chainSource = null,
  diagnostics = {},
}) {
  return {
    selectedLeg: null,
    source,
    status,
    reasonCode,
    primaryReason: reasonCode,
    reasonCodes: [...new Set([reasonCode, ...reasonCodes].filter(Boolean))],
    safeStrike,
    aggressiveStrike,
    lowerBoundaryStrike,
    upperBoundaryStrike,
    midpointStrike,
    intermediateContractCount: 0,
    quoteValidIntermediateCount: 0,
    yieldEligibleIntermediateCount: 0,
    spreadEligibleIntermediateCount: 0,
    liquidityEligibleIntermediateCount: 0,
    fullyEligibleIntermediateCount: 0,
    executionEligibleIntermediateCount: 0,
    selectedStrike: null,
    selectedDistanceFromMidpoint: null,
    selectedPeriodYieldPct: null,
    selectedYieldBandStatus: null,
    selectedExecutionEligible: false,
    balancedLegAvailable: false,
    executionEligible: false,
    includedInBalancedPool: false,
    selectedByOptimizer: null,
    notSelectedReason: null,
    dteDays,
    yieldPolicyVersion: YIELD_POLICY_VERSION,
    effectivePeriodMinPct: band?.effectivePeriodMinPct ?? null,
    effectivePeriodMaxPct: band?.effectivePeriodMaxPct ?? null,
    effectiveTargetPct:
      band?.effectivePeriodMaxPct == null
        ? null
        : (band.effectivePeriodMinPct + band.effectivePeriodMaxPct) / 2,
    chainSource,
    diagnostics,
  };
}

/**
 * Résout une vraie jambe BALANCED à partir des contrats déjà présents dans le scan.
 * Aucun fetch, interpolation de prime ou création de strike synthétique.
 */
export function resolveNativeBalancedLeg({
  candidate = {},
  safeLeg = candidate?._safeLeg ?? candidate?.safeStrike ?? null,
  aggressiveLeg = candidate?._aggLeg ?? candidate?.aggressiveStrike ?? null,
  chain = null,
  expiration = null,
  dteDays = null,
  maxSpreadPct = BALANCED_EFFECTIVE_MAX_SPREAD_PCT,
} = {}) {
  const safeStrike = Number(safeLeg?.strike);
  const aggressiveStrike = Number(aggressiveLeg?.strike);
  const resolvedDte = isValidComboDte(dteDays)
    ? Number(dteDays)
    : resolveLegDte(safeLeg ?? aggressiveLeg, candidate);
  const band = isValidComboDte(resolvedDte)
    ? getCanonicalPeriodYieldBand("BALANCED", resolvedDte)
    : null;
  const common = {
    safeStrike: Number.isFinite(safeStrike) ? safeStrike : null,
    aggressiveStrike: Number.isFinite(aggressiveStrike) ? aggressiveStrike : null,
    dteDays: resolvedDte,
    band,
  };
  if (!safeLeg || !Number.isFinite(safeStrike) || safeStrike <= 0) {
    return balancedNativeBaseResult({
      ...common,
      reasonCode: BALANCED_NATIVE_REASON_CODES.SAFE_MISSING,
    });
  }
  if (!aggressiveLeg || !Number.isFinite(aggressiveStrike) || aggressiveStrike <= 0) {
    return balancedNativeBaseResult({
      ...common,
      reasonCode: BALANCED_NATIVE_REASON_CODES.AGGRESSIVE_MISSING,
    });
  }
  if (!band) {
    return balancedNativeBaseResult({
      ...common,
      reasonCode: BALANCED_NATIVE_REASON_CODES.INVALID_DTE,
    });
  }
  const expectedExpiration =
    expiration ??
    candidate?.targetExpiration ??
    candidate?.selectedExpiration ??
    candidate?.expiration ??
    null;
  const safeExpiration = balancedExpirationKey(
    safeLeg?.expiration ?? safeLeg?.targetExpiration ?? expectedExpiration,
  );
  const aggressiveExpiration = balancedExpirationKey(
    aggressiveLeg?.expiration ?? aggressiveLeg?.targetExpiration ?? expectedExpiration,
  );
  if (safeExpiration && aggressiveExpiration && safeExpiration !== aggressiveExpiration) {
    return balancedNativeBaseResult({
      ...common,
      reasonCode: BALANCED_NATIVE_REASON_CODES.EXPIRATION_MISMATCH,
      diagnostics: { safeExpiration, aggressiveExpiration },
    });
  }
  const lowerBoundaryStrike = Math.min(safeStrike, aggressiveStrike);
  const upperBoundaryStrike = Math.max(safeStrike, aggressiveStrike);
  const midpointStrike = (lowerBoundaryStrike + upperBoundaryStrike) / 2;
  const inverted = safeStrike > aggressiveStrike;
  const reasonCodes = [];
  const geometry = {
    ...common,
    lowerBoundaryStrike,
    upperBoundaryStrike,
    midpointStrike,
  };
  if (safeStrike === aggressiveStrike) {
    return balancedNativeBaseResult({
      ...geometry,
      reasonCode: BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE,
      reasonCodes: [BALANCED_NATIVE_REASON_CODES.EQUAL_BOUNDARIES],
    });
  }
  if (inverted) {
    return balancedNativeBaseResult({
      ...geometry,
      reasonCode: BALANCED_NATIVE_REASON_CODES.INVERTED_BOUNDARIES,
      reasonCodes: [BALANCED_NATIVE_REASON_CODES.INVERTED_BOUNDARIES],
      diagnostics: { invertedSafeAggressiveOrder: true },
    });
  }
  const chainInput = resolveBalancedChainInput(candidate, chain);
  if (!chainInput.available) {
    return balancedNativeBaseResult({
      ...geometry,
      reasonCode: BALANCED_NATIVE_REASON_CODES.CHAIN_MISSING,
      reasonCodes,
    });
  }
  const ticker = String(candidate?.ticker ?? candidate?.symbol ?? "").trim().toUpperCase();
  const expectedExpirationKey = balancedExpirationKey(expectedExpiration);
  let scopeRejectedContractCount = 0;
  const intermediate = [];
  for (const row of chainInput.rows) {
    const leg = normalizeRealBalancedPutLeg(row, candidate, chainInput.source);
    if (!leg) {
      scopeRejectedContractCount += 1;
      continue;
    }
    const rowTicker = String(leg.ticker ?? "").trim().toUpperCase();
    const rowExpiration = balancedExpirationKey(leg.expiration);
    const right = String(leg.right ?? leg.optionType ?? "").trim().toUpperCase();
    const scopeOk =
      (!ticker || !rowTicker || ticker === rowTicker) &&
      (!expectedExpirationKey || !rowExpiration || expectedExpirationKey === rowExpiration) &&
      (right === "PUT" || right === "P") &&
      leg.strike > lowerBoundaryStrike &&
      leg.strike < upperBoundaryStrike;
    if (!scopeOk) {
      scopeRejectedContractCount += 1;
      continue;
    }
    intermediate.push(leg);
  }
  if (!intermediate.length) {
    return balancedNativeBaseResult({
      ...geometry,
      reasonCode: BALANCED_NATIVE_REASON_CODES.NO_INTERMEDIATE_STRIKE,
      reasonCodes,
      chainSource: chainInput.source,
      diagnostics: { scopeRejectedContractCount, invertedSafeAggressiveOrder: inverted },
    });
  }
  const evaluated = intermediate
    .map((leg) =>
      evaluateBalancedLegEligibility({
        leg,
        candidate,
        band,
        maxSpreadPct,
        requireRealQuote: true,
      }),
    )
    .sort((a, b) => compareBalancedEvaluationsByMidpoint(a, b, midpointStrike));
  const quoteValid = evaluated.filter((row) => row.quoteValid);
  const yieldEligible = evaluated.filter((row) => row.yieldEligible);
  const spreadEligible = evaluated.filter((row) => row.spreadEligible);
  const liquidityEligible = evaluated.filter((row) => row.liquidityEligible);
  const executionEligible = evaluated.filter((row) => row.executionEligible);
  const gradeEligible = evaluated.filter((row) => row.gradeEligible);
  const fullyEligible = evaluated.filter((row) => row.fullyEligible);
  let primaryReason = BALANCED_NATIVE_REASON_CODES.NONE_ELIGIBLE;
  const detailedReasons = [
    ...reasonCodes,
    BALANCED_NATIVE_REASON_CODES.INTERMEDIATE_FOUND,
  ];
  if (!quoteValid.length) {
    primaryReason = BALANCED_NATIVE_REASON_CODES.QUOTES_INVALID;
  } else if (!spreadEligible.length) {
    primaryReason = BALANCED_NATIVE_REASON_CODES.FAILED_SPREAD;
  } else if (!liquidityEligible.length) {
    primaryReason = BALANCED_NATIVE_REASON_CODES.FAILED_LIQUIDITY;
  } else if (!gradeEligible.length) {
    primaryReason = BALANCED_NATIVE_REASON_CODES.FAILED_GRADE;
  } else if (!fullyEligible.length) {
    primaryReason = BALANCED_NATIVE_REASON_CODES.FAILED_STATIC_FILTERS;
  }
  if (quoteValid.length && !yieldEligible.length) {
    detailedReasons.push(BALANCED_NATIVE_REASON_CODES.ALL_YIELDS_OUTSIDE_TARGET_BAND);
    const allBelow = quoteValid.every((row) => row.yieldBandStatus === "BELOW");
    const allAbove = quoteValid.every((row) => row.yieldBandStatus === "ABOVE");
    if (allBelow) detailedReasons.push(BALANCED_NATIVE_REASON_CODES.BELOW_MIN);
    if (allAbove) detailedReasons.push(BALANCED_NATIVE_REASON_CODES.ABOVE_MAX);
  }
  const candidateDiagnostics = evaluated.map((row, index) => ({
    rank: index + 1,
    strike: row.leg.strike,
    distanceToMidpoint: Math.abs(row.leg.strike - midpointStrike),
    bid: row.leg.bid ?? null,
    ask: row.leg.ask ?? null,
    spreadPct: row.spreadPct,
    volume: row.executionBreakdown?.volume ?? null,
    openInterest: row.executionBreakdown?.openInterest ?? null,
    executionScore: row.executionScore,
    periodYieldPct: row.periodYieldPct,
    yieldBandStatus: row.yieldBandStatus,
    quoteValid: row.quoteValid,
    spreadEligible: row.spreadEligible,
    liquidityEligible: row.liquidityEligible,
    executionEligible: row.executionEligible,
    admissionEligible: row.fullyEligible,
    rejectionReasons: row.rejectionReasons,
  }));
  if (!fullyEligible.length) {
    return {
      ...balancedNativeBaseResult({
        ...geometry,
        reasonCode: primaryReason,
        reasonCodes: [...detailedReasons, BALANCED_NATIVE_REASON_CODES.NONE_ELIGIBLE],
        chainSource: chainInput.source,
        diagnostics: {
          scopeRejectedContractCount,
          invertedSafeAggressiveOrder: inverted,
          maxSpreadPct,
          candidateDiagnostics,
        },
      }),
      intermediateContractCount: intermediate.length,
      quoteValidIntermediateCount: quoteValid.length,
      yieldEligibleIntermediateCount: yieldEligible.length,
      spreadEligibleIntermediateCount: spreadEligible.length,
      liquidityEligibleIntermediateCount: liquidityEligible.length,
      fullyEligibleIntermediateCount: 0,
      executionEligibleIntermediateCount: executionEligible.length,
    };
  }
  const selected = fullyEligible[0];
  return {
    ...balancedNativeBaseResult({
      ...geometry,
      source: BALANCED_LEG_SOURCES.NATIVE,
      status: "selected",
      reasonCode: BALANCED_NATIVE_REASON_CODES.SELECTED,
      reasonCodes: detailedReasons,
      chainSource: chainInput.source,
      diagnostics: {
        scopeRejectedContractCount,
        invertedSafeAggressiveOrder: inverted,
        maxSpreadPct,
        selectedGrade: selected.grade,
        selectedScore: selected.score,
        candidateDiagnostics,
      },
    }),
    selectedLeg: {
      ...selected.leg,
      periodYield: selected.periodYieldPct,
      weeklyNormalizedYield: selected.weeklyNormalizedYieldPct,
      spreadPct: selected.spreadPct,
      grade: selected.grade,
      score: selected.score,
      proFinalScore: selected.score,
      yieldBandStatus: selected.yieldBandStatus,
      executionEligible: true,
      capitalRequired: selected.leg.strike * 100,
    },
    intermediateContractCount: intermediate.length,
    quoteValidIntermediateCount: quoteValid.length,
    yieldEligibleIntermediateCount: yieldEligible.length,
    spreadEligibleIntermediateCount: spreadEligible.length,
    liquidityEligibleIntermediateCount: liquidityEligible.length,
    fullyEligibleIntermediateCount: fullyEligible.length,
    executionEligibleIntermediateCount: executionEligible.length,
    selectedStrike: selected.leg.strike,
    selectedDistanceFromMidpoint: Math.abs(selected.leg.strike - midpointStrike),
    selectedPeriodYieldPct: selected.periodYieldPct,
    selectedWeeklyNormalizedYieldPct: selected.weeklyNormalizedYieldPct,
    selectedSpreadPct: selected.spreadPct,
    selectedGrade: selected.grade,
    selectedYieldBandStatus: selected.yieldBandStatus,
    yieldBandStatus: selected.yieldBandStatus,
    selectedExecutionEligible: true,
    balancedLegAvailable: true,
    executionEligible: true,
    includedInBalancedPool: true,
  };
}

export function resolveBalancedLegSelection({
  candidate,
  maxSpreadPct = BALANCED_EFFECTIVE_MAX_SPREAD_PCT,
} = {}) {
  const safeLeg = candidate?._safeLeg ?? candidate?.safeStrike ?? null;
  const aggressiveLeg = candidate?._aggLeg ?? candidate?.aggressiveStrike ?? null;
  const native = resolveNativeBalancedLeg({
    candidate,
    safeLeg,
    aggressiveLeg,
    maxSpreadPct,
  });
  if (native.selectedLeg) return native;
  const dteDays = resolveLegDte(safeLeg ?? aggressiveLeg, candidate);
  if (!isValidComboDte(dteDays)) {
    return {
      ...native,
      source: BALANCED_LEG_SOURCES.UNAVAILABLE,
      status: "unavailable",
      reasonCode: BALANCED_NATIVE_REASON_CODES.NO_FALLBACK,
      primaryReason: BALANCED_NATIVE_REASON_CODES.NO_FALLBACK,
      reasonCodes: [
        ...new Set([
          ...(native.reasonCodes ?? []),
          BALANCED_NATIVE_REASON_CODES.INVALID_DTE,
          BALANCED_NATIVE_REASON_CODES.NO_FALLBACK,
        ]),
      ],
      diagnostics: {
        ...(native.diagnostics ?? {}),
        nativePrimaryReason: native.primaryReason,
      },
    };
  }
  const band = getCanonicalPeriodYieldBand("BALANCED", dteDays);
  const fallbackDescriptors = [
    {
      mode: "SAFE",
      leg: safeLeg,
      valid: candidate?._hasSafeLegValid ?? !!safeLeg,
      explicitGrade: candidate?._safeGrade ?? candidate?.safeGrade ?? null,
    },
    {
      mode: "AGGRESSIVE",
      leg: aggressiveLeg,
      valid: candidate?._hasAggLegValid ?? !!aggressiveLeg,
      explicitGrade: candidate?._aggGrade ?? candidate?.aggressiveGrade ?? null,
    },
  ]
    .filter((row) => row.valid && row.leg)
    .map((row) => ({
      ...row,
      evaluation: evaluateBalancedLegEligibility({
        leg: row.leg,
        candidate,
        band,
        maxSpreadPct,
        // Les jambes SAFE/AGGRESSIVE sont déjà validées par le scanner et
        // buildCapitalComboCandidate; conserver la compatibilité des payloads
        // historiques qui n'avaient pas toujours ask/mid.
        requireRealQuote: false,
        explicitGrade: row.explicitGrade,
      }),
    }))
    .filter((row) => row.evaluation.fullyEligible);
  if (!fallbackDescriptors.length) {
    return {
      ...native,
      source: BALANCED_LEG_SOURCES.UNAVAILABLE,
      status: "unavailable",
      reasonCode: BALANCED_NATIVE_REASON_CODES.NO_FALLBACK,
      primaryReason: BALANCED_NATIVE_REASON_CODES.NO_FALLBACK,
      reasonCodes: [
        ...new Set([
          ...(native.reasonCodes ?? []),
          BALANCED_NATIVE_REASON_CODES.NO_FALLBACK,
        ]),
      ],
      diagnostics: {
        ...(native.diagnostics ?? {}),
        nativePrimaryReason: native.primaryReason,
      },
    };
  }
  const target = (band.effectivePeriodMinPct + band.effectivePeriodMaxPct) / 2;
  // Ordre metier canonique : SAFE, puis AGGRESSIVE. Le rendement reste
  // informatif et ne peut plus reordonner ni exclure les fallbacks.
  const selected = fallbackDescriptors[0];
  const isSafe = selected.mode === "SAFE";
  return {
    ...native,
    selectedLeg: selected.leg,
    source: isSafe
      ? BALANCED_LEG_SOURCES.FALLBACK_SAFE
      : BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
    status: "fallback",
    reasonCode: isSafe
      ? BALANCED_NATIVE_REASON_CODES.FALLBACK_SAFE
      : BALANCED_NATIVE_REASON_CODES.FALLBACK_AGGRESSIVE,
    primaryReason: isSafe
      ? BALANCED_NATIVE_REASON_CODES.FALLBACK_SAFE
      : BALANCED_NATIVE_REASON_CODES.FALLBACK_AGGRESSIVE,
    reasonCodes: [
      ...new Set([
        ...(native.reasonCodes ?? []),
        isSafe
          ? BALANCED_NATIVE_REASON_CODES.FALLBACK_SAFE
          : BALANCED_NATIVE_REASON_CODES.FALLBACK_AGGRESSIVE,
      ]),
    ],
    selectedStrike: Number(selected.leg.strike),
    selectedDistanceFromMidpoint:
      native.midpointStrike == null
        ? null
        : Math.abs(Number(selected.leg.strike) - native.midpointStrike),
    effectiveTargetPct: target,
    selectedGrade: selected.evaluation.grade,
    selectedPeriodYieldPct: selected.evaluation.periodYieldPct,
    selectedWeeklyNormalizedYieldPct: selected.evaluation.weeklyNormalizedYieldPct,
    selectedSpreadPct: selected.evaluation.spreadPct,
    selectedYieldBandStatus: selected.evaluation.yieldBandStatus,
    yieldBandStatus: selected.evaluation.yieldBandStatus,
    selectedExecutionEligible: true,
    balancedLegAvailable: true,
    executionEligible: true,
    includedInBalancedPool: true,
    diagnostics: {
      ...(native.diagnostics ?? {}),
      nativePrimaryReason: native.primaryReason,
      fallbackEligibleModes: fallbackDescriptors.map((row) => row.mode),
      fallbackEvaluations: fallbackDescriptors.map((row) => ({
        mode: row.mode,
        periodYieldPct: row.evaluation.periodYieldPct,
        yieldBandStatus: row.evaluation.yieldBandStatus,
        spreadPct: row.evaluation.spreadPct,
        executionEligible: row.evaluation.executionEligible,
      })),
      effectiveTargetPct: target,
    },
  };
}

/**
 * Dernier recours AF-07 : première jambe structurellement valide dans l'ordre
 * de fallback, sans test de bande. Utilisé uniquement quand aucune jambe n'est
 * conforme, pour conserver le chemin de rejet aval existant (le candidat sera
 * rejeté par les gates de bande période avec les diagnostics
 * PERIOD_YIELD_BELOW_BUCKET_MIN / PERIOD_YIELD_ABOVE_BUCKET_MAX).
 */
function pickFirstValidLegDescriptor(legCandidates) {
  const list = Array.isArray(legCandidates) ? legCandidates : [];
  for (const d of list) {
    if (d && typeof d === "object" && d.valid === true && d.leg != null) return d;
  }
  return null;
}

/**
 * Bandes yield effectives par bucket — alignées sur modeConfigs (présentation / Inspector).
 * Les bornes s'appliquent au rendement PÉRIODE (jusqu'à expiration, %) ; les clés
 * gardent leur nom historique min/maxWeeklyYield pour compatibilité de lecture.
 */
export const BUCKET_PRESENTATION_YIELD_BANDS = Object.freeze({
  SAFE: Object.freeze({
    minWeeklyYield: SAFE_BASE_PERIOD_MIN_PCT,
    maxWeeklyYield: 0.8,
    yieldPolicyVersion: YIELD_POLICY_VERSION,
  }),
  BALANCED: Object.freeze({
    minWeeklyYield: 0.7,
    maxWeeklyYield: 1.05,
    yieldPolicyVersion: YIELD_POLICY_VERSION,
  }),
  AGGRESSIVE: Object.freeze({
    minWeeklyYield: 0.95,
    maxWeeklyYield: null,
    yieldPolicyVersion: YIELD_POLICY_VERSION,
  }),
});

/**
 * Résolution jambe bucket — même chemin que makeCombo bucket map (lecture seule, AF-14).
 * Ne modifie pas le candidat ; utilise buildCapitalComboCandidate + AF-17 + AF-07.
 */
export function resolveBucketLegForPresentation(bucketLabel, rawCandidate, usableCapital) {
  const bucketKey = String(bucketLabel || "").trim().toUpperCase();
  const cfg = BUCKET_PRESENTATION_YIELD_BANDS[bucketKey];
  if (!cfg || !rawCandidate) {
    return { source: "legacy", bucketLegAvailable: false, bucketMode: bucketKey || null };
  }

  const built = buildCapitalComboCandidate(rawCandidate, usableCapital);
  let bucketLeg = null;
  let bucketStrikeValue = null;
  let bucketGrade = null;
  let selectedLegMode = null;
  let fallbackUsed = false;
  let balancedLegResolution = null;

  if (bucketKey === "SAFE") {
    if (built._hasSafeLegValid) {
      bucketLeg = built._safeLeg;
      bucketStrikeValue = built._safeStrikeValue;
      bucketGrade = built._safeGrade;
      selectedLegMode = "SAFE";
    }
  } else if (bucketKey === "AGGRESSIVE") {
    if (built._hasAggLegValid) {
      bucketLeg = built._aggLeg;
      bucketStrikeValue = built._aggStrikeValue;
      bucketGrade = built._aggGrade;
      selectedLegMode = "AGGRESSIVE";
    }
  } else if (bucketKey === "BALANCED") {
    balancedLegResolution = resolveBalancedLegSelection({ candidate: built });
    if (balancedLegResolution.selectedLeg) {
      bucketLeg = balancedLegResolution.selectedLeg;
      bucketStrikeValue = Number(balancedLegResolution.selectedLeg.strike);
      bucketGrade =
        balancedLegResolution.selectedGrade ??
        balancedLegResolution.selectedLeg.grade ??
        null;
      selectedLegMode =
        balancedLegResolution.source === BALANCED_LEG_SOURCES.NATIVE
          ? "BALANCED"
          : balancedLegResolution.source === BALANCED_LEG_SOURCES.FALLBACK_SAFE
            ? "SAFE"
            : "AGGRESSIVE";
      fallbackUsed = balancedLegResolution.status === "fallback";
    }
  }

  if (!bucketLeg) {
    return {
      source: balancedLegResolution ? "runtime" : "legacy",
      bucketLegAvailable: false,
      bucketMode: bucketKey,
      selectedLegMode: null,
      fallbackUsed: false,
      balancedLegSource: balancedLegResolution?.source ?? null,
      balancedLegDiagnostics: balancedLegResolution,
      selectionReason: balancedLegResolution?.reasonCode ?? null,
    };
  }

  const selectedWeeklyYieldPct = getLegWeeklyNormalizedYieldPct(bucketLeg, built);
  const selectedPeriodYieldPct = getLegPeriodYieldPct(bucketLeg, built);
  const selectedSpreadPct = getLegSpreadPct(bucketLeg);
  const selectedGrade = String(
    resolveSelectedLegGrade({
      explicitGrade: bucketGrade,
      selectedLeg: bucketLeg,
      selectedMode: selectedLegMode,
      candidate: built,
    }) ?? ""
  ).toUpperCase() || null;

  return {
    source: "runtime",
    bucketLegAvailable: true,
    bucketMode: bucketKey,
    selectedLegMode,
    selectedLeg: bucketLeg,
    selectedStrike: bucketStrikeValue,
    selectedWeeklyYieldPct,
    selectedPeriodYieldPct,
    selectedSpreadPct,
    selectedGrade,
    fallbackUsed,
    balancedLegSource: balancedLegResolution?.source ?? null,
    balancedLegDiagnostics: balancedLegResolution,
    selectionReason: balancedLegResolution?.reasonCode ?? null,
  };
}

/** Métadonnées mode explicites pour pick / snapshot (AF-01). */
export function projectCapitalComboPickModeFields(candidate) {
  const bucketMode = pickMetadataString(candidate?._capitalComboMode) ?? null;
  const selectedLegMode = resolveSelectedLegMode(candidate) || null;
  const scannerMode = pickMetadataString(candidate?.finalDisplayMode) ?? null;
  return {
    bucketMode,
    selectedLegMode,
    scannerMode,
  };
}

/**
 * Vue Inspector — priorité pick runtime, sinon résolution bucket moteur, sinon legacy.
 */
export function resolveCapitalComboInspectorLegView({
  bucketKey,
  candidate,
  pick = null,
  usableCapital = 100000,
}) {
  const bucket = String(bucketKey || "").trim().toUpperCase();
  if (pick && (pick.selectedLegMode != null || pick.strike != null)) {
    return {
      source: "runtime",
      bucketLegAvailable: true,
      inPicks: true,
      bucketMode: pick.bucketMode ?? bucket,
      selectedLegMode: pick.selectedLegMode ?? null,
      selectedLeg: pick.balancedLegDiagnostics?.selectedLeg ?? null,
      selectedStrike: pick.strike ?? null,
      selectedWeeklyYieldPct: pick.weeklyReturn ?? null,
      selectedPeriodYieldPct: pick.periodYield ?? pick.selectedPeriodYieldPct ?? null,
      selectedSpreadPct: pick.spreadPct ?? null,
      selectedGrade: pick.grade ?? null,
      selectionReason: pick.selectionReason ?? null,
      fallbackUsed: pick.fallbackUsed === true,
      balancedLegSource: pick.balancedLegSource ?? null,
      balancedLegDiagnostics: pick.balancedLegDiagnostics ?? null,
      legSourceLabel: "Décision runtime (pick)",
    };
  }

  const runtime = resolveBucketLegForPresentation(bucket, candidate, usableCapital);
  if (runtime.bucketLegAvailable || runtime.source === "runtime") {
    return {
      ...runtime,
      inPicks: false,
      legSourceLabel: !runtime.bucketLegAvailable
        ? "Décision runtime (BALANCED indisponible)"
        : runtime.fallbackUsed
          ? "Décision runtime (fallback BALANCED)"
          : "Décision runtime (bucket)",
    };
  }

  return {
    source: "legacy",
    bucketLegAvailable: false,
    inPicks: false,
    bucketMode: bucket,
    selectedLegMode: null,
    selectedLeg: null,
    selectedStrike: null,
    selectedWeeklyYieldPct: null,
    selectedPeriodYieldPct: null,
    selectedSpreadPct: null,
    selectedGrade: null,
    selectionReason: null,
    fallbackUsed: false,
    legSourceLabel: "Estimation legacy — sans pick runtime",
  };
}

export function formatCapitalComboLegModeShort(selectedLegMode) {
  const m = String(selectedLegMode || "").trim().toUpperCase();
  if (m === "SAFE") return "SAFE";
  if (m === "BALANCED") return "BALANCED";
  if (m === "AGGRESSIVE") return "AGG";
  return null;
}

/** Badge jambe pour UI pick (AF-01 / AF-16). */
export function formatCapitalComboPickLegBadge(pick) {
  if (pick?.balancedLegSource === BALANCED_LEG_SOURCES.NATIVE) return "BALANCED native";
  if (pick?.balancedLegSource === BALANCED_LEG_SOURCES.FALLBACK_SAFE) return "Fallback SAFE";
  if (pick?.balancedLegSource === BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE) {
    return "Fallback AGGRESSIVE";
  }
  const legShort = formatCapitalComboLegModeShort(pick?.selectedLegMode);
  const grade = pick?.grade ? String(pick.grade).trim() : "";
  const legLabel = legShort ? `Jambe ${legShort}` : "Jambe —";
  return grade ? `${legLabel} · Grade ${grade}` : legLabel;
}

export function formatCapitalComboPickBucketContext(pick) {
  const bucket = String(pick?.bucketMode || "").trim().toUpperCase();
  if (bucket === "BALANCED") return "Bucket BALANCED";
  return null;
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

  const comboTraceRecording = resolveCapitalComboTraceDebugEnabled(options);
  const comboTraceSnapshotsByModeLabel = comboTraceRecording ? new Map() : null;

  if (!basePool.length) return [];

  const modeConfigs = [
    {
      id: "aggressive",
      label: "AGGRESSIVE",
      // Identity: high-return quality — pas de junk premium
      // Concentration plus élevée que BALANCED/SAFE : gros titres valides (ex. AMD ~42,5k) sans 100 % sur un ticker.
      tickerCapPct: 0.50,
      positionCapPct: 0.50,
      maxContractsPerTicker: 4,
      minTargetPositions: 3,
      maxThemeCapitalPct: 0.50,
      maxSectorCapitalPct: 0.50,
      maxHighBetaCapitalPct: 0.60,
      // Bande d'admissibilité — rendement PÉRIODE (jusqu'à expiration), en %.
      minWeeklyYield: 0.95,
      maxWeeklyYield: null,
      minExecutionScore: CAPITAL_COMBO_AGGRESSIVE_MIN_EXECUTION_SCORE,
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
      // Bande d'admissibilité — rendement PÉRIODE (jusqu'à expiration), en %.
      minWeeklyYield: 0.70,
      maxWeeklyYield: 1.05,
      minExecutionScore: 0,
      maxSpreadPct: 20,
      allowedModes: new Set(["SAFE", "AGGRESSIVE"]),
      allowedGrades: new Set(["A", "B"]),
      watchPremiumFilter: (c) => {
        const pop = c._popForCombo;
        const spread = c.selectedSpreadPct;
        const dist = c.selectedDistancePct;
        return (
          pop != null && pop >= 88 &&
          (spread == null || spread <= 15) &&
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
      // Bande d'admissibilité — rendement PÉRIODE base (DTE ≤ 7) ; politique hybride au gate.
      minWeeklyYield: SAFE_BASE_PERIOD_MIN_PCT,
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

    /** Audit lecture seule : aligné sur les mêmes prédicats que la ancienne chaîne filtres/map (aucun seuil modifié). */
    const rejectionAuditEnabled =
      comboTraceRecording || optimizerV2.capDiagnosticsEnabled !== false;
    const rejectionAudit = rejectionAuditEnabled ? [] : null;
    function pushScoredPoolReject(ticker, blocker, detail) {
      if (!rejectionAudit) return;
      const tk = String(ticker ?? "").trim().toUpperCase();
      if (!tk) return;
      rejectionAudit.push({ ticker: tk, primaryBlocker: blocker, ...(detail ?? {}) });
    }

    const bucketResolvedPool = basePool
      // Étape 1 : résoudre la jambe spécifique au bucket (simulation indépendante)
      .map((candidate) => {
        let bucketLeg = null;
        let bucketStrikeValue = null;
        let bucketCapital = 0;
        let bucketGrade = null;
        let bucketMode = null;
        let bucketFallbackUsed = false;
        let balancedLegResolution = null;

        if (mode.id === "conservative") {
          // SAFE : utiliser exclusivement la jambe SAFE
          if (candidate._hasSafeLegValid) {
            bucketLeg = candidate._safeLeg;
            bucketStrikeValue = candidate._safeStrikeValue;
            bucketCapital = candidate._safeCapital;
            bucketGrade = candidate._safeGrade;
            bucketMode = "SAFE";
          }
        } else if (mode.id === "aggressive") {
          // AGGRESSIVE : utiliser exclusivement la jambe AGGRESSIVE
          if (candidate._hasAggLegValid) {
            bucketLeg = candidate._aggLeg;
            bucketStrikeValue = candidate._aggStrikeValue;
            bucketCapital = candidate._aggCapital;
            bucketGrade = candidate._aggGrade;
            bucketMode = "AGGRESSIVE";
          }
        } else {
          // BALANCED : vraie jambe intermédiaire prioritaire, puis fallback
          // SAFE/AGGRESSIVE conforme à la même politique hybride.
          balancedLegResolution = resolveBalancedLegSelection({
            candidate,
            maxSpreadPct: modeAlloc.maxSpreadPct,
          });
          bucketFallbackUsed = balancedLegResolution.status === "fallback";
          if (balancedLegResolution.selectedLeg) {
            bucketLeg = balancedLegResolution.selectedLeg;
            bucketStrikeValue = Number(bucketLeg.strike);
            bucketCapital = bucketStrikeValue * 100;
            bucketGrade =
              balancedLegResolution.selectedGrade ??
              bucketLeg.grade ??
              null;
            bucketMode =
              balancedLegResolution.source === BALANCED_LEG_SOURCES.NATIVE
                ? "BALANCED"
                : balancedLegResolution.source === BALANCED_LEG_SOURCES.FALLBACK_SAFE
                  ? "SAFE"
                  : "AGGRESSIVE";
          }
        }

        if (!bucketLeg) {
          return {
            ...candidate,
            _hasBucketLeg: false,
            _balancedLegSource: balancedLegResolution?.source ?? null,
            _balancedLegDiagnostics: balancedLegResolution,
          };
        }

        const bucketPremium = getLegPremiumValue(bucketLeg);
        const bucketSpread = getLegSpreadPct(bucketLeg);
        const bucketYield = getLegWeeklyNormalizedYieldPct(bucketLeg, candidate);
        // Rendement période de la jambe bucket — seule métrique d'admissibilité des bandes.
        const bucketPeriodYield = getLegPeriodYieldPct(bucketLeg, candidate);
        const bucketDistance = getLegDistancePct(bucketLeg);
        const bucketPop = getLegPopPct(bucketLeg);
        const bucketExecutionScore = getLegExecutionScore(bucketLeg);
        const resolvedCapital = Number.isFinite(bucketStrikeValue) && bucketStrikeValue > 0
          ? bucketStrikeValue * 100
          : bucketCapital;
        const resolvedGrade = String(
          resolveSelectedLegGrade({
            explicitGrade: bucketGrade,
            selectedLeg: bucketLeg,
            selectedMode: bucketMode,
            candidate,
          }) ?? ""
        ).toUpperCase();
        const bucketCandidate = {
          ...candidate,
          selectedLeg: bucketLeg,
          selectedLegMode: bucketMode,
          _bucketSelectedMode: bucketMode,
        };
        const selectedLegPro = resolveSelectedLegProScore(bucketCandidate, {
          selectedLeg: bucketLeg,
          selectedMode: bucketMode,
        });

        return {
          ...candidate,
          _hasBucketLeg: true,
          _capitalComboMode: mode.label,
          _bucketFallbackUsed: bucketFallbackUsed,
          _balancedLegSource: balancedLegResolution?.source ?? null,
          _balancedLegDiagnostics: balancedLegResolution,
          selectedLeg: bucketLeg,
          selectedLegMode: bucketMode,
          _bucketSelectedMode: bucketMode,
          selectedLegGrade: resolvedGrade || null,
          selectedStrikeValue: bucketStrikeValue,
          selectedPremiumUnit: bucketPremium,
          selectedSpreadPct: bucketSpread,
          selectedYieldPct: bucketYield,
          selectedPeriodYieldPct: bucketPeriodYield,
          periodYieldPct: bucketPeriodYield,
          selectedDistancePct: bucketDistance,
          _popForCombo: bucketPop,
          _bucketExecutionScore: bucketExecutionScore,
          _backendProExecutionScore: candidate.proExecutionScore,
          proExecutionScore: selectedLegPro.proExecutionScore,
          proDistanceScore: selectedLegPro.proDistanceScore,
          proFinalScore: selectedLegPro.proFinalScore,
          proScoreSource: selectedLegPro.proScoreSource,
          _selectedLegProMeta: selectedLegPro,
          capitalPerContract: resolvedCapital,
          premiumPerContract: Number.isFinite(bucketPremium) && bucketPremium > 0 ? bucketPremium * 100 : 0,
          finalDisplayGrade: resolvedGrade,
          _comboGradeScore: getComboGradeScore(resolvedGrade),
          weeklyReturn: bucketYield ?? candidate.weeklyReturn,
          spreadPct: bucketSpread ?? candidate.spreadPct,
          _qualityOverlay: computeTickerQualityOverlay({
            ...candidate,
            spreadPct: bucketSpread,
            weeklyReturn: bucketYield,
            _popForCombo: bucketPop,
          }),
        };
      });

    const scoredStaging = [];
    for (const cand0 of bucketResolvedPool) {
      if (!cand0._hasBucketLeg) {
        pushScoredPoolReject(cand0.ticker, "NO_BUCKET_LEG_FOR_MODE", {
          noteFr: `Aucune jambe valide pour le bucket « ${mode.label} ».`,
          balancedLegSource: cand0._balancedLegSource ?? null,
          balancedReasonCode: cand0._balancedLegDiagnostics?.reasonCode ?? null,
          balancedReasonCodes: cand0._balancedLegDiagnostics?.reasonCodes ?? null,
          balancedLegDiagnostics: cand0._balancedLegDiagnostics ?? null,
        });
        continue;
      }
      const cand = {
        ...cand0,
        selectedStrike: getModeStrike(cand0, mode.id),
        _comboScoreBreakdown: buildCapitalComboScoreBreakdown(cand0, modeAlloc, usableCapital, poolStats),
      };

      if (!(cand.capitalPerContract > 0 && cand.capitalPerContract <= usableCapital && cand.weeklyReturn > 0)) {
        const capitalOrYieldBlocker =
          mode.id === "balanced" && cand.capitalPerContract > usableCapital
            ? "CAPITAL_INSUFFICIENT"
            : "CAPITAL_OR_YIELD_GATE";
        pushScoredPoolReject(cand.ticker, capitalOrYieldBlocker, {
          capitalPerContract: cand.capitalPerContract,
          usableCapitalUsd: usableCapital,
          weeklyReturnPct: cand.weeklyReturn,
        });
        continue;
      }
      const gradeOk =
        modeAlloc.allowedGrades?.has(cand.finalDisplayGrade) ||
        (cand.finalDisplayGrade === "WATCH" && modeAlloc.watchPremiumFilter?.(cand));
      if (!gradeOk) {
        pushScoredPoolReject(cand.ticker, "GRADE_OR_WATCH_GATE", {
          grade: cand.finalDisplayGrade,
        });
        continue;
      }

      const candWp = {
        ...cand,
        _isWatchPremium: cand.finalDisplayGrade === "WATCH" && !!modeAlloc.watchPremiumFilter?.(cand),
      };

      // Bande d'admissibilité du bucket : politique hybride sur rendement PÉRIODE.
      const bucketDteDays = resolveLegDte(candWp.selectedLeg, candWp);
      if (!isValidComboDte(bucketDteDays)) {
        pushScoredPoolReject(candWp.ticker, "MISSING_OR_INVALID_DTE_FOR_YIELD_POLICY", {
          yieldPolicyVersion: YIELD_POLICY_VERSION,
          mode: mode.label,
          periodYieldPct: Number.isFinite(Number(candWp.selectedPeriodYieldPct))
            ? Number(candWp.selectedPeriodYieldPct)
            : null,
          weeklyNormalizedYieldPct: candWp.weeklyReturn ?? null,
          noteFr: "DTE manquant ou invalide — impossible d'appliquer la politique hybride de rendement.",
        });
        continue;
      }
      const yieldBand = getCanonicalPeriodYieldBand(mode.label, bucketDteDays);
      const bucketPeriodYieldPct = Number(candWp.selectedPeriodYieldPct);
      if (
        mode.id !== "balanced" &&
        !isPeriodYieldAdmissibleInBand(bucketPeriodYieldPct, yieldBand)
      ) {
        if (!Number.isFinite(bucketPeriodYieldPct) || bucketPeriodYieldPct < yieldBand.effectivePeriodMinPct) {
          pushScoredPoolReject(candWp.ticker, "PERIOD_YIELD_BELOW_BUCKET_MIN", {
            ...buildYieldPolicyRejectionFields(
              mode.label,
              bucketDteDays,
              bucketPeriodYieldPct,
              candWp.weeklyReturn,
            ),
            noteFr:
              "Bande décidée par le rendement jusqu'à expiration (politique hybride) ; le 7J est informatif.",
          });
        } else {
          pushScoredPoolReject(candWp.ticker, "PERIOD_YIELD_ABOVE_BUCKET_MAX", {
            ...buildYieldPolicyRejectionFields(
              mode.label,
              bucketDteDays,
              bucketPeriodYieldPct,
              candWp.weeklyReturn,
            ),
            maxPeriodYieldConfig: yieldBand.effectivePeriodMaxPct,
            noteFr:
              "Bande décidée par le rendement jusqu'à expiration (politique hybride) ; le 7J est informatif.",
          });
        }
        continue;
      }
      const executionScoreForFilter = getCandidateExecutionScore(candWp, candWp.selectedLeg);
      if (
        !(
          !Number.isFinite(executionScoreForFilter) ||
          executionScoreForFilter >= modeAlloc.minExecutionScore
        )
      ) {
        pushScoredPoolReject(candWp.ticker, "MIN_EXECUTION_SCORE_NOT_MET", {
          minExecutionScore: modeAlloc.minExecutionScore,
          proExecutionScore: executionScoreForFilter,
          backendProExecutionScore: candWp._backendProExecutionScore ?? null,
          selectedSpreadPct: candWp.selectedSpreadPct,
        });
        continue;
      }
      if (!(
        Number.isFinite(candWp.spreadPct) &&
        candWp.spreadPct >= 0 &&
        candWp.spreadPct <= modeAlloc.maxSpreadPct
      )) {
        pushScoredPoolReject(candWp.ticker, "MAX_SPREAD_PCT_EXCEEDED", {
          maxSpreadPctMode: modeAlloc.maxSpreadPct,
          spreadPct: candWp.spreadPct,
        });
        continue;
      }
      if (!(
        modeAlloc.minDistancePct == null ||
        candWp.selectedDistancePct == null ||
        candWp.selectedDistancePct <= modeAlloc.minDistancePct
      )) {
        pushScoredPoolReject(candWp.ticker, "MIN_DISTANCE_PCT_BUCKET_GATE_FAILED", {
          minDistancePctConfig: modeAlloc.minDistancePct,
          selectedDistancePct: candWp.selectedDistancePct,
        });
        continue;
      }
      if (modeAlloc.filterCandidate && !modeAlloc.filterCandidate(candWp)) {
        pushScoredPoolReject(candWp.ticker, "MODE_SPECIFIC_QUALITY_OR_SPECULATIVE_FILTER", {
          qualityTier: candWp._qualityOverlay?.qualityTier ?? null,
        });
        continue;
      }

      scoredStaging.push({
        ...candWp,
        allocScore:
          (candWp._comboScoreBreakdown?.totalScore ?? modeAlloc.score(candWp)) -
          (candWp._isWatchPremium ? 15 : 0),
      });
    }

    scoredStaging.sort((a, b) =>
      b.allocScore - a.allocScore ||
      b._comboGradeScore - a._comboGradeScore ||
      (b.selectedYieldPct ?? 0) - (a.selectedYieldPct ?? 0) ||
      (a.selectedSpreadPct ?? Number.POSITIVE_INFINITY) - (b.selectedSpreadPct ?? Number.POSITIVE_INFINITY) ||
      (a.selectedDistancePct ?? 0) - (b.selectedDistancePct ?? 0) ||
      // AF-05 : départage final canonique une fois tous les critères métier égaux.
      compareCapitalComboCandidatesStable(a, b)
    );

    const scoredPool = scoredStaging;

    if (comboTraceRecording && comboTraceSnapshotsByModeLabel instanceof Map) {
      comboTraceSnapshotsByModeLabel.set(mode.label, {
        modeLabel: mode.label,
        modeId: mode.id,
        rejectedBeforeAllocation: rejectionAudit ?? [],
        scoredCandidatesOrdered: scoredPool.map((cRow, idx) =>
          serializeScoredCandidateForTrace(cRow, idx + 1, mode.label),
        ),
      });
    }
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
      // AF-08 : la phase soft n'assouplit que le nombre de contrats (+1), jamais les caps en dollars.
      const tickerCapLimit = tickerCapDollars;
      const positionCapLimit = positionCapDollars;
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
          ) ||
          (
            // AF-05 : égalité complète des critères métier → départage canonique stable.
            evaluated.marginalScore === best.marginalScore &&
            (evaluated.candidate.allocScore ?? 0) === (best.candidate.allocScore ?? 0) &&
            compareCapitalComboCandidatesStable(evaluated.candidate, best.candidate) < 0
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
      const legMetadata = projectSelectedLegMetadata(candidate);
      const modeFields = projectCapitalComboPickModeFields(candidate);
      return {
        ticker: candidate.ticker,
        mode: candidate.finalDisplayMode,
        bucketMode: modeFields.bucketMode ?? mode.label,
        selectedLegMode: modeFields.selectedLegMode,
        scannerMode: modeFields.scannerMode,
        fallbackUsed: candidate._bucketFallbackUsed === true,
        balancedLegSource: candidate._balancedLegSource ?? null,
        balancedLegDiagnostics: candidate._balancedLegDiagnostics ?? null,
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
        // Rendement période (jusqu'à expiration) de la jambe bucket — décide la bande ;
        // weeklyReturn (7J normalisé) reste persisté pour comparaison DTE.
        periodYield: Number.isFinite(Number(candidate.selectedPeriodYieldPct))
          ? Number(candidate.selectedPeriodYieldPct)
          : null,
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
        expiration: legMetadata.expiration,
        expirationSource: legMetadata.expirationSource,
        expirationMismatch: legMetadata.expirationMismatch || undefined,
        dte: legMetadata.dte,
        bid: legMetadata.bid,
        ask: legMetadata.ask,
        mid: legMetadata.mid,
        rank: legMetadata.rank,
        finalRank: legMetadata.finalRank,
        optionSymbol: legMetadata.optionSymbol,
        conId: legMetadata.conId,
        contractId: legMetadata.contractId,
        quoteTimestamp: legMetadata.quoteTimestamp,
        marketDataType: legMetadata.marketDataType,
        quoteSource: legMetadata.quoteSource,
        proScoreSource: candidate.proScoreSource ?? candidate?._selectedLegProMeta?.proScoreSource ?? null,
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
          ) ||
          (
            // AF-05 : égalité complète des critères métier → départage canonique stable.
            enriched.marginalScore === best.marginalScore &&
            enriched._fillerFreeAfter === best._fillerFreeAfter &&
            (!enriched.isExisting === !best.isExisting) &&
            (enriched.candidate.weeklyReturn ?? 0) === (best.candidate.weeklyReturn ?? 0) &&
            compareCapitalComboCandidatesStable(enriched.candidate, best.candidate) < 0
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
          ) ||
          (
            // AF-05 : égalité complète des critères métier → départage canonique stable.
            enriched.marginalScore === best.marginalScore &&
            enriched._fillerFreeAfter === best._fillerFreeAfter &&
            (!enriched.isExisting === !best.isExisting) &&
            compareCapitalComboCandidatesStable(enriched.candidate, best.candidate) < 0
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

    const avgWeekly =
      picks.length > 0
        ? picks.reduce((sum, p) => sum + p.weeklyReturn * p.capitalUsed, 0) /
          picks.reduce((sum, p) => sum + p.capitalUsed, 0)
        : 0;
    const usedPct = usableCapital > 0 ? (used / usableCapital) * 100 : 0;
    let capitalShortfallReason = null;
    if (usedPct < targetMinPct) {
      const hasAnyCandidate = scoredPool.length > 0;
      const hasAnyPick = picks.length > 0;
      const minContractCost = hasAnyCandidate
        ? Math.min(...scoredPool.map((c) => c.capitalPerContract))
        : Number.POSITIVE_INFINITY;
      const dominantGreedyBlocker = (() => {
        if (!(rejectionTotals instanceof Map) || rejectionTotals.size === 0) return null;
        let best = null;
        let bestCount = 0;
        for (const [reason, count] of rejectionTotals.entries()) {
          const n = Number(count);
          if (!Number.isFinite(n) || n <= 0) continue;
          if (n > bestCount) {
            bestCount = n;
            best = reason;
          }
        }
        return best;
      })();
      if (!hasAnyCandidate) {
        capitalShortfallReason = "not_enough_candidates";
      } else if (!hasAnyPick) {
        capitalShortfallReason = dominantGreedyBlocker ?? "caps_too_strict";
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
    let unusedCapitalDiagnostic = null;
    if (optimizerV2.capDiagnosticsEnabled !== false) {
      const evaluateStrict = (c) => evaluateCandidate(c, false);
      const residualDiagnosticRows = buildNextBestResidualRows(
        scoredPool,
        pickMap,
        evaluateStrict,
        { limit: 36 },
      );
      const scoredPoolNotSelected = buildScoredPoolNotSelectedDiagnostics(
        scoredPool,
        pickMap,
        evaluateStrict,
        {
          modeLabel: mode.label ?? null,
          usedCapital: used,
          usableCapital,
          maxPositionLines,
          candidateSweepIndexByTicker: candidateSweepIndexByTicker,
          lastEvaluatedPhase: "post_allocation_residual",
        },
      );

      unusedCapitalDiagnostic = buildTerminalUnusedCapitalDiagnostic({
        freeCapitalUsd: usableCapital - used,
        usableCapitalUsd: usableCapital,
        usedCapitalUsd: used,
        scoredPool,
        pickMap,
        evaluateCandidateStrict: evaluateStrict,
        picksCount: picks.length,
        maxPositionLines,
        rejectedBeforeAllocation: rejectionAudit ?? [],
        modeLabel: mode.label ?? null,
        minPeriodYieldPct: modeAlloc.minWeeklyYield ?? null,
        usedPct,
        targetMinPct,
      });

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
        scoredPoolTickers: scoredPool.map((c) => c.ticker),
        scoredPoolNotSelected,
        rejectedBeforeAllocation: rejectionAudit ?? [],
        unusedCapitalDiagnostic,
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

      if (unusedCapitalDiagnostic?.legacyShortfallReason && usedPct < targetMinPct) {
        capitalShortfallReason = unusedCapitalDiagnostic.legacyShortfallReason;
      }
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
    const balancedLegSourceCounts =
      mode.id === "balanced"
        ? {
            native: bucketResolvedPool.filter(
              (row) => row?._balancedLegSource === BALANCED_LEG_SOURCES.NATIVE,
            ).length,
            fallbackSafe: bucketResolvedPool.filter(
              (row) => row?._balancedLegSource === BALANCED_LEG_SOURCES.FALLBACK_SAFE,
            ).length,
            fallbackAggressive: bucketResolvedPool.filter(
              (row) => row?._balancedLegSource === BALANCED_LEG_SOURCES.FALLBACK_AGGRESSIVE,
            ).length,
            unavailable: bucketResolvedPool.filter(
              (row) => row?._balancedLegSource === BALANCED_LEG_SOURCES.UNAVAILABLE,
            ).length,
          }
        : null;

    return {
      label: mode.label,
      positions: picksOut.length,
      totalCapital: used,
      capitalPct: capital > 0 ? (used / capital) * 100 : 0,
      capitalTargetReached: usedPct >= targetMinPct,
      capitalShortfallReason,
      avgWeeklyReturn: avgWeekly,
      // Reliquat du capital déployable uniquement — la réserve hors maxCapitalPct est exclue.
      freeCapital: Math.max(0, usableCapital - used),
      picks: picksOut,
      balancedLegSourceCounts,
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

  if (comboTraceRecording) {
    const payloadTrace = assembleCapitalComboAllocationTraceV1({
      basePool,
      builtCombos,
      comboTraceSnapshotsByModeLabel,
      grossCapital: capital,
      maxCapitalPct,
      maxPositions,
      usableCapital,
      rejectedIbkrSymbolsSize: rejectedIbkrSymbols.size,
    });
    if (options?.comboTracePayloadHolder && typeof options.comboTracePayloadHolder === "object") {
      options.comboTracePayloadHolder.capitalComboAllocationTraceV1 = payloadTrace;
    }
    if (!options.capitalComboTraceSuppressConsoleLogs) {
      comboTraceEmitConsoleSummary(payloadTrace, null);
    }
  }

  if (!builtCombos.length) return builtCombos;
  const crossModeOverlap = computeCrossModeOverlapLocal(builtCombos);
  return builtCombos.map(combo => ({ ...combo, crossModeOverlap }));
}
