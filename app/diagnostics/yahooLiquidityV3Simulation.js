/**
 * Yahoo Liquidity V3 — simulation read-only (flag YAHOO_LIQUIDITY_V3_SIMULATION) et logique partagée avec le live safe
 * (YAHOO_LIQUIDITY_V3_LIVE_SAFE). La simulation n’altère pas la sélection seule ; le live safe réintègre des rejets
 * Yahoo liquidité uniquement quand son flag est actif.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAX_ABSOLUTE_SPREAD } from "../config/constants.js";
import { toNumber } from "../utils/number.js";

const LOG = "[yahoo-liquidity-v3]";
export const LOG_YAHOO_LIQUIDITY_V3_LIVE = "[yahoo-liquidity-v3-live]";

/** Symboles fréquemment levier / macro — drapeaux de risque informatifs uniquement. */
const LEVERAGED_ETF_HINTS = new Set([
  "TQQQ",
  "SQQQ",
  "SOXL",
  "SOXS",
  "UPRO",
  "SPXU",
  "TNA",
  "TZA",
  "LABU",
  "LABD",
  "TECL",
  "TECS",
  "FAS",
  "FAZ",
]);

const MACRO_ETF_HINTS = new Set([
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "VTI",
  "IVV",
  "VOO",
  "EEM",
  "GLD",
]);

/** @returns {boolean} */
export function isYahooLiquidityV3SimulationEnabled() {
  const raw = String(process.env.YAHOO_LIQUIDITY_V3_SIMULATION || "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

/** @returns {boolean} — ON par défaut ; désactiver avec YAHOO_LIQUIDITY_V3_LIVE_SAFE=0 */
export function isYahooLiquidityV3LiveSafeEnabled() {
  const raw = String(process.env.YAHOO_LIQUIDITY_V3_LIVE_SAFE ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "false") return false;
  return true;
}

/**
 * Plafond spread absolu pour la simulation uniquement (dollars). Surcharge : YAHOO_LIQUIDITY_V3_MAX_ABSOLUTE_SPREAD.
 * @returns {number}
 */
export function resolvedV3SimulationMaxAbsoluteSpread() {
  const raw = process.env.YAHOO_LIQUIDITY_V3_MAX_ABSOLUTE_SPREAD;
  if (raw == null || String(raw).trim() === "") return 0.35;
  const n = Number(String(raw).trim().replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return 0.35;
  return Math.min(2.5, n);
}

/**
 * Buckets stricts pour la récupération simulée V3 (qualité carnet ATM).
 * @param {Record<string, unknown> | null | undefined} liquidity
 * @returns {"high" | "medium" | "weak"}
 */
export function classifyV3RecoveryBucket(liquidity) {
  const abs = toNumber(liquidity?.absoluteSpread);
  const sp = toNumber(liquidity?.spreadPct);
  const vol = toNumber(liquidity?.volume);
  const oi = toNumber(liquidity?.openInterest);
  /** Cohort « échec spread absolu seul » vs baseline : spread dollar > seuil Yahoo standard. */
  if (!(abs > MAX_ABSOLUTE_SPREAD)) return "weak";

  const withinV3Cap = abs > 0 && abs <= 0.35;

  if (withinV3Cap && sp <= 12 && vol >= 100 && oi >= 100) return "high";
  if (withinV3Cap && sp <= 20 && vol >= 50 && oi >= 50) return "medium";
  return "weak";
}

/**
 * Population « échec uniquement sur spread absolu » (toutes les autres sonde Yahoo inchangées).
 * @param {Record<string, unknown> | null | undefined} liquidity
 */
export function isAbsoluteSpreadOnlyLiquidityFailure(liquidity) {
  const c = liquidity?.checks;
  if (!c || typeof c !== "object") return false;
  if (c.hasRealMarket !== true) return false;
  if (c.rejectReason != null && String(c.rejectReason).trim() !== "") return false;
  if (c.spreadPctOk !== true) return false;
  if (c.volumeOk !== true || c.openInterestOk !== true) return false;
  if (c.absoluteSpreadOk !== false) return false;
  return true;
}

/**
 * Drapeaux de risque informatifs (même jeu que la simulation V3).
 *
 * @param {string} symbol
 * @param {number} absVal spread absolu ATM ($)
 * @returns {string[]}
 */
export function buildV3LiquidityRiskFlags(symbol, absVal) {
  const sym = String(symbol || "")
    .trim()
    .toUpperCase();
  const abs = toNumber(absVal);
  const risk = [];
  if (LEVERAGED_ETF_HINTS.has(sym)) risk.push("leveraged_etf_hint");
  if (MACRO_ETF_HINTS.has(sym)) risk.push("macro_etf_hint");
  if (abs > 0.3) risk.push("elevated_absolute_spread");
  return risk;
}

/**
 * Éligibilité récupération Yahoo Liquidity V3 (même règles que {@link runYahooLiquidityV3Simulation}).
 * Entrée au format `rejectedCandidates` de watchlistDiagnosticsV1.
 *
 * @param {Record<string, unknown>} row
 * @param {{
 *   maxAbsoluteSpreadV3?: number,
 *   baselineMaxAbsoluteSpread?: number,
 * }} [opts]
 * @returns {{
 *   kind: string,
 *   symbol?: string,
 *   bucket?: string,
 *   recoveryReason?: string,
 *   liquiditySnapshot?: Record<string, unknown>,
 *   risks?: string[],
 *   detail?: Record<string, unknown>,
 *   [key: string]: unknown,
 * }}
 */
export function evaluateYahooLiquidityV3RecoveryEligibility(row, opts = {}) {
  const baselineMaxAbs = opts.baselineMaxAbsoluteSpread ?? MAX_ABSOLUTE_SPREAD;
  const maxAbsV3 = opts.maxAbsoluteSpreadV3 ?? resolvedV3SimulationMaxAbsoluteSpread();

  const sym = String(row?.symbol || "")
    .trim()
    .toUpperCase();
  const stage = String(row?.rejectionStage || "");
  if (stage !== "yahoo_liquidity") {
    return { kind: "skip_non_yahoo_stage" };
  }

  const reasons = Array.isArray(row?.rejectionReasons) ? row.rejectionReasons.map(String) : [];
  const primary = reasons[0] || "";
  const partial = row?.partialMetrics && typeof row.partialMetrics === "object" ? row.partialMetrics : {};
  const detail = partial?.detail && typeof partial.detail === "object" ? partial.detail : {};
  const liquidity = detail?.liquidity && typeof detail.liquidity === "object" ? detail.liquidity : null;

  if (primary === "liquid_options_otm_probe_failed") {
    return { kind: "exclude_otm", symbol: sym, detail: { ...detail } };
  }

  if (primary !== "liquid_options_failed") {
    return { kind: "skip_non_liquid_primary" };
  }

  const code = String(detail?.code || "");
  if (code !== "atm_put_not_liquid" || !liquidity) {
    return {
      kind: "exclude_other_liquid",
      symbol: sym,
      code: code || "unknown",
      strike: detail?.strike ?? null,
    };
  }

  const checks = liquidity.checks;
  if (checks?.hasRealMarket !== true || (checks?.rejectReason != null && String(checks.rejectReason).trim() !== "")) {
    return {
      kind: "exclude_no_real_bid_ask",
      symbol: sym,
      rejectReason: checks?.rejectReason ?? "no_real_bid_ask",
      liquidityChecks: checks ?? null,
    };
  }

  if (checks?.spreadPctOk === false) {
    return {
      kind: "exclude_spread_pct",
      symbol: sym,
      spreadPct: liquidity.spreadPct ?? null,
    };
  }

  if (!isAbsoluteSpreadOnlyLiquidityFailure(liquidity)) {
    return {
      kind: "exclude_pattern_not_pure",
      symbol: sym,
      code,
      checks,
    };
  }

  const bucket = classifyV3RecoveryBucket(liquidity);
  const absVal = toNumber(liquidity.absoluteSpread);
  const wouldPassV3 = absVal > 0 && absVal <= maxAbsV3;
  const recoveryReason = `balanced_v3: absolute_spread ${absVal} <= sim_max ${maxAbsV3} (baseline max ${baselineMaxAbs}) ; volume/oi/spreadPct inchangés`;
  const risks = buildV3LiquidityRiskFlags(sym, absVal);

  if (bucket === "weak") {
    return {
      kind: "exclude_weak",
      symbol: sym,
      bucket,
      absoluteSpread: liquidity.absoluteSpread ?? null,
      spreadPct: liquidity.spreadPct ?? null,
      wouldPassV3,
      risks,
    };
  }

  if (!wouldPassV3) {
    return {
      kind: "exclude_over_cap",
      symbol: sym,
      bucket,
      absoluteSpread: liquidity.absoluteSpread ?? null,
      spreadPct: liquidity.spreadPct ?? null,
      simulatedMaxAbsoluteSpread: maxAbsV3,
      risks,
    };
  }

  return {
    kind: "recovered",
    symbol: sym,
    bucket,
    recoveryReason,
    risks,
    liquiditySnapshot: {
      absoluteSpread: liquidity.absoluteSpread ?? null,
      spreadPct: liquidity.spreadPct ?? null,
      volume: liquidity.volume ?? null,
      openInterest: liquidity.openInterest ?? null,
      checks: liquidity.checks ?? null,
    },
  };
}

/**
 * @param {string} sym
 * @param {string[] | undefined} risks
 * @param {string[]} leveragedFlagged
 * @param {string[]} macroEtfFlagged
 */
function mergeV3SimulationRiskFlags(sym, risks, leveragedFlagged, macroEtfFlagged) {
  if (!Array.isArray(risks)) return;
  if (risks.includes("leveraged_etf_hint") && !leveragedFlagged.includes(sym)) leveragedFlagged.push(sym);
  if (risks.includes("macro_etf_hint") && !macroEtfFlagged.includes(sym)) macroEtfFlagged.push(sym);
}

/**
 * @param {Record<string, unknown>} watchlistDiagnosticsV1
 * @param {{
 *   maxAbsoluteSpreadV3?: number,
 *   baselineMaxAbsoluteSpread?: number,
 *   stats?: { retainedAfterFiltersCount?: unknown, limitApplied?: unknown } | null,
 * }} [opts]
 */
export function runYahooLiquidityV3Simulation(watchlistDiagnosticsV1, opts = {}) {
  const baselineMaxAbs = opts.baselineMaxAbsoluteSpread ?? MAX_ABSOLUTE_SPREAD;
  const maxAbsV3 = opts.maxAbsoluteSpreadV3 ?? resolvedV3SimulationMaxAbsoluteSpread();

  const baselineKept = toNumber(watchlistDiagnosticsV1?.watchlistKeptCount) ?? 0;
  const stats = opts.stats && typeof opts.stats === "object" ? opts.stats : null;
  const retainedAfterFiltersCount = toNumber(stats?.retainedAfterFiltersCount);
  const limitApplied = toNumber(stats?.limitApplied);
  const rejectedList = Array.isArray(watchlistDiagnosticsV1?.rejectedCandidates)
    ? watchlistDiagnosticsV1.rejectedCandidates
    : [];

  /** @type {string[]} */
  const recoveredSymbols = [];
  /** @type {Record<string, unknown>[]} */
  const recoveredDetail = [];
  /** @type {string[]} */
  const highRecovered = [];
  /** @type {string[]} */
  const mediumRecovered = [];
  /** @type {Record<string, unknown>[]} */
  const weakBucketExcludedDetail = [];
  /** @type {Record<string, unknown>[]} */
  const overSimulationCapDetail = [];
  /** @type {string[]} */
  const leveragedFlagged = [];
  /** @type {string[]} */
  const macroEtfFlagged = [];
  /** @type {Record<string, unknown>[]} */
  const noRealBidAskExcluded = [];
  /** @type {Record<string, unknown>[]} */
  const otmProbeExcluded = [];
  /** @type {Record<string, unknown>[]} */
  const spreadPctFailedBaseline = [];
  /** @type {Record<string, unknown>[]} */
  const otherLiquidFailures = [];

  let yahooLiquidityRejected = 0;

  for (const row of rejectedList) {
    const stage = String(row?.rejectionStage || "");
    if (stage !== "yahoo_liquidity") continue;
    yahooLiquidityRejected += 1;

    const sym = String(row?.symbol || "")
      .trim()
      .toUpperCase();

    const ev = evaluateYahooLiquidityV3RecoveryEligibility(row, {
      maxAbsoluteSpreadV3: maxAbsV3,
      baselineMaxAbsoluteSpread: baselineMaxAbs,
    });

    switch (ev.kind) {
      case "exclude_otm":
        otmProbeExcluded.push({
          symbol: sym,
          reason: "otm_probe_excluded_for_now",
          detail: ev.detail && typeof ev.detail === "object" ? { ...ev.detail } : {},
        });
        break;
      case "skip_non_liquid_primary":
        break;
      case "exclude_other_liquid":
        otherLiquidFailures.push({
          symbol: sym,
          code: String(ev.code || "unknown"),
          detailSnippet: { strike: ev.strike ?? null },
        });
        break;
      case "exclude_no_real_bid_ask":
        noRealBidAskExcluded.push({
          symbol: sym,
          rejectReason: ev.rejectReason ?? "no_real_bid_ask",
          liquidityChecks: ev.liquidityChecks ?? null,
        });
        break;
      case "exclude_spread_pct":
        spreadPctFailedBaseline.push({
          symbol: sym,
          spreadPct: ev.spreadPct ?? null,
          note: "spreadPctOk baseline false — jamais relâché en V3 simulation",
        });
        break;
      case "exclude_pattern_not_pure":
        otherLiquidFailures.push({
          symbol: sym,
          code: ev.code,
          note: "liquidity pattern_not_pure_absolute_spread_failure",
          checks: ev.checks,
        });
        break;
      case "exclude_weak":
        mergeV3SimulationRiskFlags(sym, ev.risks, leveragedFlagged, macroEtfFlagged);
        weakBucketExcludedDetail.push({
          symbol: sym,
          bucket: ev.bucket,
          absoluteSpread: ev.absoluteSpread ?? null,
          spreadPct: ev.spreadPct ?? null,
          wouldPassV3: ev.wouldPassV3,
          note: "weak_false_reject cohort — exclu de la récupération simulée (scénario maître)",
        });
        break;
      case "exclude_over_cap":
        mergeV3SimulationRiskFlags(sym, ev.risks, leveragedFlagged, macroEtfFlagged);
        overSimulationCapDetail.push({
          symbol: sym,
          bucket: ev.bucket,
          absoluteSpread: ev.absoluteSpread ?? null,
          spreadPct: ev.spreadPct ?? null,
          simulatedMaxAbsoluteSpread: ev.simulatedMaxAbsoluteSpread,
          note: "hors plafond V3 (maxAbsoluteSpreadV3) — qualité high/medium mais spread absolu trop large pour ce scénario",
        });
        break;
      case "recovered":
        mergeV3SimulationRiskFlags(sym, ev.risks, leveragedFlagged, macroEtfFlagged);
        recoveredSymbols.push(sym);
        if (ev.bucket === "high") highRecovered.push(sym);
        else mediumRecovered.push(sym);
        recoveredDetail.push({
          symbol: sym,
          bucket: ev.bucket,
          recoveryReason: ev.recoveryReason,
          risks: ev.risks,
          liquiditySnapshot: ev.liquiditySnapshot,
        });
        break;
      default:
        break;
    }
  }

  const simulatedRecoveredCount = recoveredSymbols.length;
  const weakBucketExcludedCount = weakBucketExcludedDetail.length;
  const overSimulationCapCount = overSimulationCapDetail.length;

  const uniqueRecovered = [...new Set(recoveredSymbols)];
  const estimatedKeptRowsIncrease = uniqueRecovered.length;

  const approxIbkr =
    estimatedKeptRowsIncrease > 0
      ? {
          note:
            "Approximation : chaque symbole récupéré en watchlist peut être scanné côté client (profondeur variable). Aucun appel IBKR supplémentaire n’est émis par ce serveur.",
          approxAdditionalSymbolsIfClientScansAll: estimatedKeptRowsIncrease,
        }
      : {
          note: "Aucune récupération simulée — pas d’effet IBKR marginal estimé.",
          approxAdditionalSymbolsIfClientScansAll: 0,
        };

  const watchlistImpact = {
    baselineWatchlistKeptCount: baselineKept,
    simulatedAdditionalSymbolsPassingYahooLiquidity: estimatedKeptRowsIncrease,
    note:
      "Les titres récupérés passeraient le filtre liquidité Yahoo (ATM) sous plafond V3 ; le classement final (sortScore, limite watchlist) peut tronquer ou réordonner — non resimulé ici.",
    retainedAfterFiltersCountIfPresent: Number.isFinite(retainedAfterFiltersCount) ? retainedAfterFiltersCount : null,
    limitAppliedIfPresent: Number.isFinite(limitApplied) ? limitApplied : null,
    estimatedRetainedAfterFiltersAfterSim:
      Number.isFinite(retainedAfterFiltersCount) && retainedAfterFiltersCount >= 0
        ? retainedAfterFiltersCount + estimatedKeptRowsIncrease
        : null,
  };

  return {
    version: "yahoo_liquidity_v3_simulation_v1",
    scenario: "balanced_v3_controlled_absolute_spread",
    exportedAt: new Date().toISOString(),
    parameters: {
      baselineMaxAbsoluteSpread: baselineMaxAbs,
      simulatedMaxAbsoluteSpread: maxAbsV3,
      buckets: {
        high: "absoluteSpread <= 0.35, spreadPct <= 12, volume >= 100, openInterest >= 100",
        medium: "absoluteSpread <= 0.35, spreadPct <= 20, volume >= 50, openInterest >= 50 (hors high)",
        weak: "reste — jamais récupéré par la simulation V3",
      },
    },
    baseline: {
      watchlistKeptCount: baselineKept,
      yahooLiquidityRejectionRows: yahooLiquidityRejected,
    },
    simulated: {
      recoveredCount: simulatedRecoveredCount,
      recoveredSymbols: uniqueRecovered.sort(),
      highQualityRecovered: [...new Set(highRecovered)].sort(),
      mediumQualityRecovered: [...new Set(mediumRecovered)].sort(),
      recoveredDetail,
    },
    excluded: {
      weakBucketExcludedCount,
      weakBucketExcludedDetail,
      overSimulationCapCount,
      overSimulationCapDetail,
      noRealBidAskExcludedCount: noRealBidAskExcluded.length,
      noRealBidAskExcluded,
      otmProbeExcludedForNowCount: otmProbeExcluded.length,
      otmProbeExcludedForNow: otmProbeExcluded,
      spreadPctBaselineFailedCount: spreadPctFailedBaseline.length,
      spreadPctBaselineFailed: spreadPctFailedBaseline,
      otherLiquidFailuresCount: otherLiquidFailures.length,
      otherLiquidFailures,
    },
    risk: {
      leveragedFlagged,
      macroEtfFlagged,
    },
    impact: {
      watchlist: watchlistImpact,
      ibkr: approxIbkr,
    },
  };
}

/**
 * @param {string} repoRoot
 * @param {Record<string, unknown>} simulationPayload
 * @returns {{ path: string }}
 */
export function writeYahooLiquidityV3SimulationReport(repoRoot, simulationPayload) {
  const debugDir = join(repoRoot, "debug");
  mkdirSync(debugDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
  const filename = `yahoo-liquidity-v3-simulation-${stamp}.json`;
  const filePath = join(debugDir, filename);
  writeFileSync(filePath, JSON.stringify(simulationPayload, null, 2), "utf8");
  return { path: filePath };
}

/**
 * @param {Record<string, unknown>} simulationResult — sortie de {@link runYahooLiquidityV3Simulation}
 */
export function logYahooLiquidityV3Summary(simulationResult) {
  const base = simulationResult?.baseline;
  const sim = simulationResult?.simulated;
  const excl = simulationResult?.excluded;
  const risk = simulationResult?.risk;
  const impact = simulationResult?.impact;

  const kept = base?.watchlistKeptCount ?? "—";
  const yLiqRej = base?.yahooLiquidityRejectionRows ?? "—";
  console.warn(`${LOG} baseline watchlistKept=${kept} yahoo_liquidity_rejections=${yLiqRej}`);

  const nRec = sim?.recoveredCount ?? 0;
  const hi = Array.isArray(sim?.highQualityRecovered) ? sim.highQualityRecovered.length : 0;
  const med = Array.isArray(sim?.mediumQualityRecovered) ? sim.mediumQualityRecovered.length : 0;
  console.warn(`${LOG} recovered count=${nRec} high=${hi} medium=${med}`);

  const wk = excl?.weakBucketExcludedCount ?? 0;
  const overCap = excl?.overSimulationCapCount ?? 0;
  console.warn(`${LOG} excluded weak count=${wk} (cohorte weak — jamais récupérée)`);
  console.warn(`${LOG} excluded over_v3_cap count=${overCap} (high/medium mais spread absolu > plafond sim)`);

  const lev = risk?.leveragedFlagged?.length ?? 0;
  const macro = risk?.macroEtfFlagged?.length ?? 0;
  console.warn(`${LOG} risk flags leveraged=${lev} macro_etf=${macro}`);

  const add = impact?.watchlist?.simulatedAdditionalSymbolsPassingYahooLiquidity ?? nRec;
  const ibkr = impact?.ibkr?.approxAdditionalSymbolsIfClientScansAll ?? add;
  console.warn(
    `${LOG} SUMMARY récupérés=${nRec} high=${hi} medium=${med} weak_exclus=${wk} over_v3_cap=${overCap} ` +
      `impact_watchlist_Δ≈+${add} titres passant liquidité Yahoo (non re-classés) · IBKR_client≈+${ibkr} si scan complet`
  );
}
