/**
 * Yahoo Funnel Diagnostics V1 — observabilité pure (lecture / export).
 * Aucune influence sur la sélection Wheel, watchlist ou IBKR.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toNumber } from "../utils/number.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @returns {boolean} */
export function isYahooFunnelDiagnosticsV1Enabled() {
  const raw = String(process.env.YAHOO_FUNNEL_DIAGNOSTICS || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/**
 * Score 0–100 : spread ATM serré = meilleur (approximation diagnostic).
 * @param {number | null | undefined} spreadPct
 */
export function atmSpreadToLiquidityScore(spreadPct) {
  const sp = toNumber(spreadPct);
  if (!(sp > 0)) return null;
  if (sp <= 5) return Math.round(100 - sp * 4);
  if (sp <= 15) return Math.round(80 - (sp - 5) * 3);
  if (sp <= 40) return Math.round(50 - (sp - 15) * 1.5);
  return Math.max(0, Math.round(15 - (sp - 40) * 0.5));
}

/**
 * @param {string | undefined} reason
 * @returns {string}
 */
export function rejectionStageFromWatchlistReason(reason) {
  const r = String(reason || "").trim();
  if (!r) return "unknown";
  if (["above_max_price", "below_min_price", "price_unavailable"].includes(r)) return "price_filter";
  if (["below_min_volume", "volume_unavailable"].includes(r)) return "volume_filter";
  if (["contract_capital_above_max"].includes(r)) return "capital_filter";
  if (["market_cap_below_min"].includes(r)) return "fundamentals_filter";
  if (["expirations_unavailable", "no_weekly_options"].includes(r)) return "weekly_options";
  if (["chain_unavailable", "liquid_options_failed", "liquid_options_otm_probe_failed"].includes(r))
    return "yahoo_liquidity";
  if (r === "error") return "error";
  return "other";
}

/**
 * @param {string | undefined} reason
 * @returns {string}
 */
export function rejectionStageFromScanReason(reason) {
  const r = String(reason || "").trim();
  if (!r || r === "not_ok") return "scan_failure";
  if (
    [
      "expiration_not_available",
      "no_spot_price",
      "invalid_lower_bound",
    ].includes(r)
  )
    return "data_or_expiration";
  if (r === "no_put_with_bid_below_lower_bound") return "strike_geometry";
  if (r === "no_liquid_strike_below_lower_bound") return "yahoo_liquidity_gap";
  if (r === "premium_below_target") return "premium";
  if (r === "yield_below_target") return "yield";
  if (r === "safe_strike_not_liquid") return "liquidity";
  if (r === "no_safe_strike_at_or_above_target_bid" || r === "no_safe_candidate_at_or_above_target_bid")
    return "safe_selection";
  if (r === "filtered_out") return "unknown_filter";
  return "wheel_filter";
}

/**
 * Diagnostic uniquement — estime si un appel IBKR vaut la peine après Yahoo.
 * @param {Record<string, unknown>} item résultat scanTicker ok:true (tel quel du scanner).
 * @returns {{ preIbkrConfidenceScore: number, preIbkrConfidenceBucket: string, preIbkrConfidenceFactors: string[] }}
 */
export function computePreIbkrConfidenceScore(item) {
  const factors = [];
  let score = 52;

  if (item?.noYahooLiquidity === true) {
    score -= 28;
    factors.push("no_yahoo_liquidity");
  }

  const spread = toNumber(item?.safeStrike?.liquidity?.spreadPct);
  if (spread > 0) {
    if (spread <= 5) {
      score += 12;
      factors.push("spread_tight");
    } else if (spread <= 12) {
      score += 6;
    } else if (spread <= 20) {
      score -= 4;
      factors.push("spread_wide");
    } else {
      score -= 18;
      factors.push("spread_very_wide");
    }
  }

  const target = toNumber(item?.targetPremium);
  const bid = toNumber(item?.safeStrike?.conservativePremium);
  if (target > 0 && bid > 0) {
    const ratio = bid / target;
    if (ratio >= 1.25) {
      score += 10;
      factors.push("premium_margin_strong");
    } else if (ratio >= 1) {
      score += 5;
    } else if (ratio >= 0.88) {
      score -= 4;
      factors.push("premium_near_miss");
    } else {
      score -= 14;
      factors.push("premium_weak");
    }
  }

  const ann = toNumber(item?.safeStrike?.annualizedYield);
  if (ann >= 0.4) {
    score += 8;
    factors.push("yield_high");
  } else if (ann >= 0.26) {
    score += 4;
  } else if (ann > 0) {
    score -= 12;
    factors.push("yield_below_gate");
  }

  if (item?.expectedMoveIncomplete === true) {
    score -= 10;
    factors.push("expected_move_incomplete");
  }

  const sup = String(item?.supportStatusUsedByQualityScore || item?.supportStatusLegacy || "");
  if (sup === "current_below_support") {
    score -= 14;
    factors.push("price_below_support");
  } else if (sup === "strike_above_support") {
    score -= 6;
  }

  if (item?.hasUpcomingEarningsBeforeExpiration === true) {
    score -= 12;
    factors.push("earnings_before_expiration");
  }

  const ivEdge = item?.diagnosticsV12?.ivHvEdge;
  if (ivEdge === true) {
    score += 6;
    factors.push("iv_above_hv");
  } else if (ivEdge === false) {
    score -= 4;
  }

  const sd = item?.debug?.strikeDebug;
  const putsBelow = toNumber(sd?.putsBelowLowerBoundWithBidCount);
  const putsTotal = toNumber(sd?.putsTotalCount);
  if (putsTotal > 0 && putsBelow === 0) {
    score -= 6;
    factors.push("puts_below_bound_sparse");
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let bucket = "moderate";
  if (score >= 88) bucket = "elite";
  else if (score >= 72) bucket = "strong";
  else if (score >= 48) bucket = "moderate";
  else if (score >= 26) bucket = "weak";
  else bucket = "likely_waste";

  return { preIbkrConfidenceScore: score, preIbkrConfidenceBucket: bucket, preIbkrConfidenceFactors: factors };
}

/**
 * Drapeaux forensics (affichage / tri futurs — aucun impact sélection).
 * @param {Record<string, unknown>} item
 * @param {{ preIbkrConfidenceScore?: number }} preIbkr
 */
export function buildScanYahooFunnelFlags(item, preIbkr) {
  const flags = [];
  const push = (id, active) => {
    if (active) flags.push(id);
  };

  push("yahoo_unreliable", item?.noYahooLiquidity === true);

  const target = toNumber(item?.targetPremium);
  const bid = toNumber(item?.safeStrike?.conservativePremium);
  const ratio = target > 0 && bid > 0 ? bid / target : null;
  push(
    "premium_near_miss",
    item?.passesFilter === true && ratio != null && ratio >= 0.92 && ratio < 1.05
  );

  const spread = toNumber(item?.safeStrike?.liquidity?.spreadPct);
  push(
    "liquidity_near_miss",
    item?.passesFilter === true && spread > 12 && spread <= 22
  );

  const score = toNumber(preIbkr?.preIbkrConfidenceScore);
  push("likely_ibkr_reject", Number.isFinite(score) && score < 28);

  push(
    "likely_false_negative",
    item?.passesFilter === true &&
      item?.expectedMoveIncomplete === true &&
      ratio != null &&
      ratio >= 1
  );

  return {
    yahoo_funnel_flags_v1: flags,
    yahoo_unreliable: item?.noYahooLiquidity === true,
    premium_near_miss: ratio != null && ratio >= 0.85 && ratio < 1 && item?.passesFilter === true,
    liquidity_near_miss: item?.passesFilter === true && spread > 10 && spread <= 22,
    likely_ibkr_reject: Number.isFinite(score) && score < 28,
    likely_false_negative:
      item?.passesFilter === true && item?.expectedMoveIncomplete === true && ratio != null && ratio >= 1.05,
  };
}

/**
 * @param {{
 *   rankBeforeLimit: number,
 *   watchlistScore: number,
 *   sortScore: number,
 *   excludedByLimit: boolean,
 *   atmLiquidityScore: number | null,
 * }} row
 * @param {{ limitCutoffSortScore: number }} ctx
 */
export function buildWatchlistYahooFunnelFlags(row, ctx) {
  const excludedByLimitButViable =
    row.excludedByLimit === true &&
    row.sortScore >= ctx.limitCutoffSortScore - 0.01 &&
    row.watchlistScore >= 58 &&
    (row.atmLiquidityScore == null || row.atmLiquidityScore >= 35);

  return {
    excluded_by_limit_but_viable: excludedByLimitButViable,
    yahoo_funnel_flags_v1: [...(excludedByLimitButViable ? ["excluded_by_limit_but_viable"] : [])],
  };
}

/**
 * Agrège diagnostics pour export forensic unique.
 * @param {Record<string, unknown>} parts
 */
export function buildYahooFunnelForensicPayload(parts) {
  const exportedAt = new Date().toISOString();
  const bucketStats =
    parts.scanFunnelDiagnosticsV1?.preIbkrBucketCounts &&
    typeof parts.scanFunnelDiagnosticsV1.preIbkrBucketCounts === "object"
      ? parts.scanFunnelDiagnosticsV1.preIbkrBucketCounts
      : null;

  return {
    version: "yahoo_funnel_forensic_v1",
    exportedAt,
    ibkrPipelineNote:
      "Les appels IBKR batch sont déclenchés côté client (dashboard) à partir du shortlist Yahoo ; ce fichier capture le funnel Yahoo serveur + métadonnées.",
    ...parts,
    summary: {
      exportedAt,
      universeTotalCount: parts.watchlistDiagnosticsV1?.universeTotalCount ?? null,
      watchlistKept: parts.watchlistDiagnosticsV1?.watchlistKeptCount ?? null,
      watchlistRejected: parts.watchlistDiagnosticsV1?.watchlistRejectedCount ?? null,
      watchlistTruncated: parts.watchlistDiagnosticsV1?.watchlistTruncatedCount ?? null,
      scanInputTickers: parts.scanFunnelDiagnosticsV1?.inputTickerCount ?? null,
      scanWheelPassed: parts.scanFunnelDiagnosticsV1?.wheelPassedCount ?? null,
      scanRejected: parts.scanFunnelDiagnosticsV1?.rejectedTickerCount ?? null,
      preIbkrBucketCounts: bucketStats,
    },
  };
}

/**
 * Écrit `debug/yahoo-funnel-diagnostics-[YYYY-MM-DDTHH-mm-ss].json` sous la racine du repo.
 * @param {string} repoRoot absolu ou relatif (ex. cwd)
 * @param {Record<string, unknown>} forensicPayload
 * @returns {{ path: string }}
 */
export function writeYahooFunnelForensicExport(repoRoot, forensicPayload) {
  const debugDir = join(repoRoot, "debug");
  mkdirSync(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const filename = `yahoo-funnel-diagnostics-${stamp}.json`;
  const path = join(debugDir, filename);
  writeFileSync(path, JSON.stringify(forensicPayload, null, 2), "utf8");
  return { path };
}

/** Racine repo par défaut : parent de `app/diagnostics`. */
export function defaultWheelRepoRoot() {
  return join(__dirname, "..", "..");
}

/**
 * @param {{
 *   cleanedTickers: string[],
 *   shortlistFullSorted: Record<string, unknown>[],
 *   rejected: Record<string, unknown>[],
 *   errors: Record<string, unknown>[],
 *   scanBySymbol: Map<string, Record<string, unknown>>,
 *   returnLimit: number,
 *   completedScanCount: number,
 * }} p
 */
export function buildScanFunnelDiagnosticsV1(p) {
  const {
    cleanedTickers,
    shortlistFullSorted,
    rejected,
    errors,
    scanBySymbol,
    returnLimit,
    completedScanCount,
  } = p;

  const inputTickerCount = cleanedTickers.length;
  const scannedTickerCount = completedScanCount;
  const wheelPassedCount = shortlistFullSorted.filter((x) => x?.passesFilter === true).length;
  const yahooUnreliableIncludedCount = shortlistFullSorted.filter(
    (x) => x?.ok !== false && x?.passesFilter !== true
  ).length;
  const rejectedTickerCount = rejected.length;
  const errorTickerCount = errors.length;

  /** @type {Record<string, number>} */
  const preIbkrBucketCounts = {};
  const bumpBucket = (b) => {
    const k = String(b || "unknown");
    preIbkrBucketCounts[k] = (preIbkrBucketCounts[k] ?? 0) + 1;
  };

  /** @type {Record<string, unknown>[]} */
  const passedCandidates = [];
  for (let si = 0; si < shortlistFullSorted.length; si++) {
    const item = shortlistFullSorted[si];
    if (item?.passesFilter !== true) continue;
    const preIbkr = computePreIbkrConfidenceScore(item);
    bumpBucket(preIbkr.preIbkrConfidenceBucket);
    const flags = buildScanYahooFunnelFlags(item, preIbkr);
    const explicit = [];
    if (flags.yahoo_unreliable) explicit.push("yahoo_unreliable");
    if (flags.premium_near_miss) explicit.push("premium_near_miss");
    if (flags.liquidity_near_miss) explicit.push("liquidity_near_miss");
    if (flags.likely_ibkr_reject) explicit.push("likely_ibkr_reject");
    if (flags.likely_false_negative) explicit.push("likely_false_negative");
    const summaryParts = [
      `rang_shortlist=${si + 1}`,
      `quality=${item?.qualityScore ?? "—"}`,
      `confiance_IBKR_diag=${preIbkr.preIbkrConfidenceScore} (${preIbkr.preIbkrConfidenceBucket})`,
    ];
    if (flags.yahoo_unreliable) summaryParts.push("yahoo_unreliable");
    passedCandidates.push({
      symbol: item.symbol,
      yahooRank: si + 1,
      qualityScore: item?.qualityScore ?? null,
      finalScore: item?.finalScore ?? null,
      annualizedYield: item?.safeStrike?.annualizedYield ?? null,
      premiumTargetHit: item?.debug?.passesPremiumTarget === true,
      passesLiquidity: item?.debug?.passesLiquidity === true,
      supportStatusLegacy: item?.supportStatusLegacy ?? null,
      supportStatusV2: item?.supportStatusV2 ?? null,
      supportDeltaV2: item?.qualityScoreDeltaLegacyVsV2 ?? null,
      noYahooLiquidity: item?.noYahooLiquidity === true,
      preIbkrRiskFlags: preIbkr.preIbkrConfidenceFactors,
      likelyIbkrWeakness:
        preIbkr.preIbkrConfidenceBucket === "weak" || preIbkr.preIbkrConfidenceBucket === "likely_waste"
          ? preIbkr.preIbkrConfidenceFactors
          : [],
      diagnosticsSummary: summaryParts.join(" · "),
      preIbkrConfidenceScore: preIbkr.preIbkrConfidenceScore,
      preIbkrConfidenceBucket: preIbkr.preIbkrConfidenceBucket,
      yahooFunnelFlagsV1: flags,
      yahooFunnelExplicitFlags: explicit,
    });
  }

  const rejectedCandidatesDetailed = [];

  for (const r of rejected) {
    const sym = String(r.symbol || "").trim().toUpperCase();
    const full = scanBySymbol.get(sym) ?? null;
    const reason = String(r.reason || "unknown");
    const rejectionStage = rejectionStageFromScanReason(reason);
    const dbg = full?.debug ?? {};
    const safe = full?.safeStrike ?? r.safeStrike ?? null;
    const targetPrem = toNumber(full?.targetPremium ?? r.targetPremium);
    const bid = toNumber(safe?.conservativePremium);
    const premiumShortfall =
      targetPrem > 0 && bid > 0 && bid < targetPrem ? round4(targetPrem - bid) : null;
    const yieldShortfall =
      dbg.passesYieldTarget === false && safe
        ? Math.max(0, 0.26 - toNumber(safe.annualizedYield))
        : null;
    const liquidityFailure = dbg.passesLiquidity === false;
    const supportFailure =
      full &&
      (full.supportStatusUsedByQualityScore === "current_below_support" ||
        full.supportStatusLegacy === "current_below_support");
    const dataQualityIssues = [];
    if (full?.expectedMoveIncomplete) dataQualityIssues.push("expected_move_incomplete");
    if (full?.expiration && reason === "expiration_not_available") dataQualityIssues.push("expiration_mismatch");
    const nearMissFlags = [];
    if (premiumShortfall != null && premiumShortfall > 0 && premiumShortfall <= targetPrem * 0.08) {
      nearMissFlags.push("premium_near_miss");
    }
    const spread = toNumber(safe?.liquidity?.spreadPct);
    if (spread > 10 && spread <= 22) nearMissFlags.push("liquidity_near_miss");

    rejectedCandidatesDetailed.push({
      symbol: sym,
      yahooRank: null,
      rejectionReason: reason,
      rejectionStage,
      premiumShortfall,
      yieldShortfall,
      liquidityFailure,
      supportFailure,
      dataQualityIssues,
      nearMissFlags,
    });
  }

  for (const err of errors) {
    const sym = String(err.symbol || "").trim().toUpperCase();
    rejectedCandidatesDetailed.push({
      symbol: sym,
      yahooRank: null,
      rejectionReason: String(err.error || "scan_failed"),
      rejectionStage: "exception",
      premiumShortfall: null,
      yieldShortfall: null,
      liquidityFailure: false,
      supportFailure: false,
      dataQualityIssues: ["scan_exception"],
      nearMissFlags: [],
    });
  }

  for (const sym of cleanedTickers) {
    const item = scanBySymbol.get(sym);
    if (!item || item.ok !== true) continue;
    if (item.passesFilter === true) continue;
    const reason = String(item.debug?.reasonKept || "yahoo_lane_without_wheel_pass");
    if (reason !== "no_liquid_strike_below_lower_bound") continue;
    const preIbkr = computePreIbkrConfidenceScore(item);
    rejectedCandidatesDetailed.push({
      symbol: sym,
      yahooRank: null,
      rejectionReason: reason,
      rejectionStage: rejectionStageFromScanReason(reason),
      premiumShortfall: null,
      yieldShortfall: null,
      liquidityFailure: false,
      supportFailure: false,
      dataQualityIssues: item.expectedMoveIncomplete ? ["expected_move_incomplete"] : [],
      nearMissFlags: ["yahoo_unreliable_lane"],
      diagnosticsNote:
        "Conservé dans shortlist Yahoo (voie unreliable) pour inspection IBKR — hors filtre Wheel habituel.",
      preIbkrConfidenceScore: preIbkr.preIbkrConfidenceScore,
      preIbkrConfidenceBucket: preIbkr.preIbkrConfidenceBucket,
    });
  }

  return {
    inputTickerCount,
    scannedTickerCount,
    passedTickerCount: wheelPassedCount,
    wheelPassedCount,
    yahooUnreliableIncludedCount,
    rejectedTickerCount,
    errorTickerCount,
    returnedTickerCap: returnLimit,
    passedCandidates,
    rejectedCandidatesDetailed,
    preIbkrBucketCounts,
    ibkrDispatchNote:
      "Liste exacte des symboles envoyés à IBKR dépend du client (profondeur audit, Elite, etc.). Utiliser preIbkrConfidenceScore pour prioriser.",
    futureInspectorHints: {
      yahooFunnelInspector: "watchlistDiagnosticsV1 + scanFunnelDiagnosticsV1.passedCandidates",
      missedCandidates:
        "watchlistDiagnosticsV1.fullRankedCandidates (excluded_by_limit_but_viable) + rejectedCandidatesDetailed",
      ibkrWasteAnalyzer: "preIbkrConfidenceBucket likely_waste | weak + yahoo_unreliable",
    },
  };
}

function round4(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null;
}
