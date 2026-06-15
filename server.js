import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_BACKEND_PORT, DEFAULT_LIQUIDITY_OTM_PROBE_PCT } from "./app/config/constants.js";
import {
  formatIbkrTwoPhaseScanLog,
  logIbkrTwoPhaseScanConfig,
  formatIbkrQuickPremiumGateLog,
  logIbkrQuickPremiumGateConfig,
  formatIbkrProgressiveSafeScanLog,
  logIbkrProgressiveSafeScanConfig,
  resolveIbkrProgressiveSafeScanEnabled,
  resolveIbkrProgressiveSafeScanMaxValidPuts,
  logIbkrScanBatchSizeConfig,
  logIbkrScanConcurrencyConfig,
  resolveIbkrQuickPremiumGateEnabled,
  resolveIbkrScanBatchSize,
  resolveIbkrScanConcurrency,
  resolveIbkrTwoPhaseScanEnabled,
  IBKR_SCAN_BATCH_SIZE_DEFAULT,
  IBKR_SCAN_BATCH_SIZE_MIN,
  IBKR_SCAN_BATCH_SIZE_MAX,
} from "./app/config/ibkr.js";
import { createMarketDataProvider } from "./app/data_providers/createMarketDataProvider.js";
import { createMarketService } from "./app/services/marketService.js";
import { createWheelScanner } from "./app/scanners/wheelScanner.js";
import { createWatchlistCache } from "./app/watchlist/watchlistCache.js";
import { createWatchlistBuilder } from "./app/watchlist/watchlistBuilder.js";
import { buildResearchExpandedPool } from "./app/watchlist/researchExpandedPool.js";
import { getIbkrHealthStatus } from "./app/ibkr/ibkrHealthStatus.js";
import {
  classifyAssignmentDepth,
  createWheelValidationService,
  summarizeAssignmentDepthCounts,
} from "./app/journal/wheelValidationService.js";
import { createWheelValidationStore } from "./app/journal/wheelValidationStore.js";
import { createTickerScanMemoryStore } from "./app/journal/tickerScanMemoryStore.js";
import { createScanFunnelArchiveStore } from "./app/journal/scanFunnelArchiveStore.js";
import createScanFunnelArchiveRoutes from "./app/journal/scanFunnelArchiveRoutes.js";
import seasonalityRoutes from "./app/seasonality/seasonalityRoutes.js";
import createAdaptiveCalibrationRoutes from "./app/calibration/adaptiveCalibrationRoutes.js";
import createCapitalCombinationRoutes from "./app/capital/capitalCombinationRoutes.js";
import {
  buildYahooFunnelForensicPayload,
  defaultWheelRepoRoot,
  isYahooFunnelDiagnosticsV1Enabled,
  writeYahooFunnelForensicExport,
} from "./app/diagnostics/yahooFunnelDiagnosticsV1.js";
import {
  isYahooLiquidityV3SimulationEnabled,
  logYahooLiquidityV3Summary,
  runYahooLiquidityV3Simulation,
  writeYahooLiquidityV3SimulationReport,
} from "./app/diagnostics/yahooLiquidityV3Simulation.js";

const app = express();
const PORT = process.env.PORT || DEFAULT_BACKEND_PORT;

/** Défaut Zod pour `liquidityOtmProbePct` : constante projet, surchargeable par `LIQUIDITY_OTM_PROBE_PCT`. */
function resolvedDefaultLiquidityOtmProbePct() {
  const raw = process.env.LIQUIDITY_OTM_PROBE_PCT;
  if (raw == null || String(raw).trim() === "") return DEFAULT_LIQUIDITY_OTM_PROBE_PCT;
  const n = Number(String(raw).trim().replace(",", "."));
  if (!Number.isFinite(n)) return DEFAULT_LIQUIDITY_OTM_PROBE_PCT;
  return Math.min(45, Math.max(0, n));
}

const defaultLiquidityOtmProbePct = resolvedDefaultLiquidityOtmProbePct();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const provider = createMarketDataProvider();
const marketService = createMarketService(provider);
const wheelScanner = createWheelScanner(marketService);
const watchlistCache = createWatchlistCache();
const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });
const useSqliteJournal = String(process.env.USE_SQLITE_JOURNAL || "true").trim().toLowerCase() === "true";
const wheelValidationStore = useSqliteJournal
  ? (await import("./app/journal/wheelValidationStoreSqlite.js")).createWheelValidationStoreSqlite()
  : createWheelValidationStore();
const wheelValidationService = createWheelValidationService({
  store: wheelValidationStore,
  marketService,
  getHistoricalClose: (symbol, dateYmd) => marketService.getHistoricalClose(symbol, dateYmd),
  getHistoricalWindowMetrics: (symbol, scanDateYmd, expirationDateYmd) =>
    marketService.getHistoricalWindowMetrics(symbol, scanDateYmd, expirationDateYmd),
});

// Phase 1 — ticker_scan_memory : mémoire historique read-only par ticker.
// N'altère NI la sélection du scan, NI le ranking, NI le scoring. Écrit après
// chaque /ibkr/shadow/scan une fois les résultats IBKR connus.
const tickerScanMemoryStore = createTickerScanMemoryStore({
  sqlitePath: wheelValidationStore?.sqlitePath,
});

// Phase 1 — scan_funnel_archive : trace compacte read-only du pipeline
// univers → watchlist → Yahoo → IBKR → UI, archivée par scanSessionId.
// Même base SQLite que Journal POP. N'altère NI la sélection, NI le scoring,
// NI Journal POP. Best-effort : alimenté par le dashboard via /scan-funnel/archive.
const scanFunnelArchiveStore = createScanFunnelArchiveStore({
  sqlitePath: wheelValidationStore?.sqlitePath,
});

/** Snapshot dernier /universe/build pour fusion export forensic (YAHOO_FUNNEL_DIAGNOSTICS=1). */
let yahooFunnelLastWatchlistDiagnosticsV1 = null;
/** Rejets watchlist avant fusion V3 live (build avec SIM+LIVE) — cohérence rapport simulation sur scan. */
let yahooFunnelLastRejectedCandidatesBeforeV3LiveSafe = null;

/**
 * Rapport read-only Yahoo Liquidity V3 (`YAHOO_LIQUIDITY_V3_SIMULATION=1`) — n’altère pas la sélection.
 * Live safe (`YAHOO_LIQUIDITY_V3_LIVE_SAFE=1`) : récupération dans `watchlistBuilder` uniquement.
 * Quand les deux flags sont actifs, `payload.rejectedCandidatesBeforeYahooLiquidityV3LiveSafe` alimente la simulation pour garder les rejets Yahoo avant récupération live.
 * @param {Record<string, unknown> | null | undefined} watchlistDiagnosticsV1
 * @param {Record<string, unknown> | null | undefined} [stats]
 * @param {Record<string, unknown> | null | undefined} [buildWatchlistPayload]
 * @returns {string | null}
 */
function maybeExportYahooLiquidityV3Simulation(watchlistDiagnosticsV1, stats, buildWatchlistPayload = undefined) {
  if (!isYahooLiquidityV3SimulationEnabled() || !watchlistDiagnosticsV1) return null;
  try {
    const pre = buildWatchlistPayload?.rejectedCandidatesBeforeYahooLiquidityV3LiveSafe;
    const v1 =
      Array.isArray(pre) ?
        { ...watchlistDiagnosticsV1, rejectedCandidates: pre }
      : watchlistDiagnosticsV1;
    const simulation = runYahooLiquidityV3Simulation(v1, { stats: stats ?? null });
    logYahooLiquidityV3Summary(simulation);
    const { path } = writeYahooLiquidityV3SimulationReport(defaultWheelRepoRoot(), simulation);
    return path;
  } catch (e) {
    console.warn("[yahoo-liquidity-v3] export error:", e?.message || e);
    return null;
  }
}

function parseSafeJson(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function numberOrNullSafe(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTheoreticalCycleSoldFilter(value) {
  const raw = String(value ?? "all").trim().toLowerCase();
  if (raw === "sold" || raw === "wait" || raw === "all") return raw;
  return "all";
}

function getTheoreticalCycleDbPath() {
  return wheelValidationStore?.sqlitePath ?? path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
}

function readTheoreticalCyclesSnapshot({ limit = 200, ticker = "", status = "", sold = "all" } = {}) {
  const sqlitePath = getTheoreticalCycleDbPath();
  if (!existsSync(sqlitePath)) {
    return {
      summary: {
        cycles_total: 0,
        cycles_open: 0,
        cycles_closed: 0,
        cc_steps_total: 0,
        cc_sold_total: 0,
        cc_wait_total: 0,
        tickers_count: 0,
        total_cc_premium_conservative: 0,
        avg_cc_premium_conservative: null,
        avg_reduced_cost_basis: null,
        best_threshold_global: null,
        cycles_recovered: 0,
        cycles_not_recovered: 0,
        recovery_rate_pct: null,
      },
      cycles: [],
    };
  }

  const conn = new DatabaseSync(sqlitePath);
  const limitValue = Math.min(Math.max(toPositiveInt(limit, 200), 1), 1000);
  const normalizedTicker = String(ticker ?? "").trim().toUpperCase();
  const normalizedStatus = String(status ?? "").trim().toLowerCase();
  const normalizedSold = normalizeTheoreticalCycleSoldFilter(sold);

  let cyclesSql = "SELECT * FROM theoretical_wheel_cycles WHERE 1=1";
  const cycleParams = {};
  if (normalizedTicker) {
    cyclesSql += " AND UPPER(ticker) = @ticker";
    cycleParams.ticker = normalizedTicker;
  }
  if (normalizedStatus) {
    cyclesSql += " AND LOWER(status) = @status";
    cycleParams.status = normalizedStatus;
  }
  cyclesSql += " ORDER BY created_at DESC";

  const rawCycles = conn.prepare(cyclesSql).all(cycleParams);
  if (!Array.isArray(rawCycles) || rawCycles.length === 0) {
    return {
      summary: {
        cycles_total: 0,
        cycles_open: 0,
        cycles_closed: 0,
        cc_steps_total: 0,
        cc_sold_total: 0,
        cc_wait_total: 0,
        tickers_count: 0,
        total_cc_premium_conservative: 0,
        avg_cc_premium_conservative: null,
        avg_reduced_cost_basis: null,
        best_threshold_global: null,
        cycles_recovered: 0,
        cycles_not_recovered: 0,
        recovery_rate_pct: null,
      },
      cycles: [],
    };
  }

  const cycleIds = rawCycles.map((cycle) => String(cycle.id));
  const stepPlaceholders = cycleIds.map((_, index) => `@cycleId${index}`).join(", ");
  const stepParams = Object.fromEntries(cycleIds.map((id, index) => [`cycleId${index}`, id]));
  const rawSteps = conn.prepare(
    `SELECT * FROM theoretical_cc_steps WHERE theoretical_cycle_id IN (${stepPlaceholders}) ORDER BY theoretical_cycle_id ASC, sequence_number ASC`
  ).all(stepParams);

  const stepsByCycleId = new Map();
  for (const step of rawSteps) {
    const cycleId = String(step.theoretical_cycle_id ?? "");
    if (!cycleId) continue;
    if (!stepsByCycleId.has(cycleId)) stepsByCycleId.set(cycleId, []);
    stepsByCycleId.get(cycleId).push(step);
  }

  const mappedCycles = rawCycles.map((cycle) => {
    const cycleId = String(cycle.id);
    const steps = stepsByCycleId.get(cycleId) ?? [];
    const firstStepRow = steps[0] ?? null;
    const firstStepRaw = firstStepRow ? parseSafeJson(firstStepRow.raw_json) : null;
    const firstStep = firstStepRow
      ? {
          test_date: firstStepRow.test_date ?? null,
          cc_expiration: firstStepRow.cc_expiration ?? null,
          dte: numberOrNullSafe(firstStepRow.dte),
          stock_price_used: numberOrNullSafe(firstStepRow.stock_price_used),
          stock_open: numberOrNullSafe(firstStepRow.stock_open),
          stock_high: numberOrNullSafe(firstStepRow.stock_high),
          stock_low: numberOrNullSafe(firstStepRow.stock_low),
          stock_close: numberOrNullSafe(firstStepRow.stock_close),
          cc_strike: numberOrNullSafe(firstStepRow.cc_strike),
          premium_conservative: numberOrNullSafe(firstStepRow.premium_conservative),
          premium_mid: numberOrNullSafe(firstStepRow.premium_mid ?? firstStepRow.premium_estimated),
          cc_yield_conservative_pct: numberOrNullSafe(firstStepRow.cc_yield_conservative_pct),
          cc_sold_theoretical: Number(firstStepRow.cc_sold_theoretical) === 1 ? 1 : 0,
          not_sold_reason: firstStepRow.not_sold_reason ?? null,
          best_threshold_reached: numberOrNullSafe(firstStepRow.best_threshold_reached),
          before_recovery_flag: Number(firstStepRow.before_recovery_flag) === 1 ? 1 : Number(firstStepRow.before_recovery_flag) === 0 ? 0 : null,
          days_after_assignment: numberOrNullSafe(firstStepRow.days_after_assignment),
          priceRule: firstStepRaw?.priceRule ?? null,
          priceQuality: firstStepRaw?.priceQuality ?? null,
          usedPostAssignmentOhlc: typeof firstStepRaw?.usedPostAssignmentOhlc === "boolean" ? firstStepRaw.usedPostAssignmentOhlc : null,
          usedFallback: typeof firstStepRaw?.usedFallback === "boolean" ? firstStepRaw.usedFallback : null,
        }
      : null;

    const ccStepsSummary = steps.map((stepRow) => ({
      sequence_number: numberOrNullSafe(stepRow.sequence_number),
      test_date: stepRow.test_date ?? null,
      cc_expiration: stepRow.cc_expiration ?? null,
      cc_strike: numberOrNullSafe(stepRow.cc_strike),
      spot_at_test: numberOrNullSafe(stepRow.stock_price_used),
      premium_conservative: numberOrNullSafe(stepRow.premium_conservative),
      premium_mid: numberOrNullSafe(stepRow.premium_mid ?? stepRow.premium_estimated),
      cc_yield_conservative_pct: numberOrNullSafe(stepRow.cc_yield_conservative_pct),
      cc_sold_theoretical: Number(stepRow.cc_sold_theoretical) === 1 ? 1 : 0,
      not_sold_reason: stepRow.not_sold_reason ?? null,
      days_after_assignment: numberOrNullSafe(stepRow.days_after_assignment),
      before_recovery_flag: Number(stepRow.before_recovery_flag) === 1 ? 1 : Number(stepRow.before_recovery_flag) === 0 ? 0 : null,
      assignment_recovered_at_step_flag: Number(stepRow.assignment_recovered_at_step_flag) === 1 ? 1 : 0,
      expiration_close: numberOrNullSafe(stepRow.expiration_close),
      expiration_price_source: stepRow.expiration_price_source ?? null,
      result_at_expiration: stepRow.result_at_expiration ?? null,
      called_away_theoretical: Number(stepRow.called_away_theoretical) === 1 ? 1 : 0,
      expired_otm: Number(stepRow.expired_otm) === 1 ? 1 : 0,
    }));

    return {
      id: cycle.id,
      ticker: cycle.ticker ?? null,
      strike_mode: cycle.strike_mode ?? null,
      assignment_date: cycle.assignment_date ?? null,
      assignment_strike: numberOrNullSafe(cycle.assignment_strike),
      assignment_price: numberOrNullSafe(cycle.assignment_price),
      spot_at_assignment: numberOrNullSafe(cycle.spot_at_assignment),
      csp_premium: numberOrNullSafe(cycle.csp_premium),
      total_cc_premium_conservative: numberOrNullSafe(cycle.total_cc_premium_conservative) ?? 0,
      total_premium_estimated: numberOrNullSafe(cycle.total_premium_estimated) ?? 0,
      reduced_cost_basis_estimated: numberOrNullSafe(cycle.reduced_cost_basis_estimated),
      initial_net_cost_basis: numberOrNullSafe(cycle.initial_net_cost_basis),
      cc_sellable_steps_count: numberOrNullSafe(cycle.cc_sellable_steps_count) ?? 0,
      cc_wait_steps_count: numberOrNullSafe(cycle.cc_wait_steps_count) ?? 0,
      cc_steps_count: numberOrNullSafe(cycle.cc_steps_count) ?? numberOrNullSafe(cycle.current_step) ?? 0,
      cc_sold_count: numberOrNullSafe(cycle.cc_sold_count) ?? numberOrNullSafe(cycle.cc_sellable_steps_count) ?? 0,
      cc_not_sold_count: numberOrNullSafe(cycle.cc_not_sold_count) ?? numberOrNullSafe(cycle.cc_wait_steps_count) ?? 0,
      weeks_without_cc: numberOrNullSafe(cycle.weeks_without_cc) ?? 0,
      cc_premiums_before_recovery: numberOrNullSafe(cycle.cc_premiums_before_recovery) ?? 0,
      cc_count_before_recovery: numberOrNullSafe(cycle.cc_count_before_recovery) ?? 0,
      weeks_without_cc_before_recovery: numberOrNullSafe(cycle.weeks_without_cc_before_recovery) ?? 0,
      latest_cc_test_date: cycle.latest_cc_test_date ?? null,
      multi_cc_backfilled_at: cycle.multi_cc_backfilled_at ?? null,
      best_cc_threshold_reached: numberOrNullSafe(cycle.best_cc_threshold_reached),
      days_to_strike_touch: numberOrNullSafe(cycle.days_to_strike_touch),
      days_to_strike_close_above: numberOrNullSafe(cycle.days_to_strike_close_above),
      days_below_assignment_strike: numberOrNullSafe(cycle.days_below_assignment_strike),
      assignment_recovery_date: cycle.assignment_recovery_date ?? null,
      assignment_recovered: Number(cycle.assignment_recovered) === 1 ? 1 : Number(cycle.assignment_recovered) === 0 ? 0 : null,
      cycle_status: cycle.cycle_status ?? (String(cycle.status ?? "").toLowerCase() === "closed_theoretical" ? "closed" : "open"),
      final_exit_date: cycle.final_exit_date ?? null,
      final_exit_price: numberOrNullSafe(cycle.final_exit_price),
      final_exit_step_id: cycle.final_exit_step_id ?? null,
      final_exit_sequence_number: numberOrNullSafe(cycle.final_exit_sequence_number),
      close_reason: cycle.close_reason ?? null,
      called_away_count: numberOrNullSafe(cycle.called_away_count) ?? 0,
      expired_otm_count: numberOrNullSafe(cycle.expired_otm_count) ?? 0,
      last_evaluated_cc_expiration: cycle.last_evaluated_cc_expiration ?? null,
      gross_stock_pnl_per_share: numberOrNullSafe(cycle.gross_stock_pnl_per_share),
      premium_pnl_per_share: numberOrNullSafe(cycle.premium_pnl_per_share),
      total_pnl_per_share: numberOrNullSafe(cycle.total_pnl_per_share),
      total_pnl_contract: numberOrNullSafe(cycle.total_pnl_contract),
      return_on_assignment_pct: numberOrNullSafe(cycle.return_on_assignment_pct),
      return_on_net_cost_pct: numberOrNullSafe(cycle.return_on_net_cost_pct),
      days_in_cycle: numberOrNullSafe(cycle.days_in_cycle),
      days_after_assignment_to_exit: numberOrNullSafe(cycle.days_after_assignment_to_exit),
      annualized_return_after_assignment_pct: numberOrNullSafe(cycle.annualized_return_after_assignment_pct),
      final_exit_backfilled_at: cycle.final_exit_backfilled_at ?? null,
      status: cycle.status ?? null,
      current_step: numberOrNullSafe(cycle.current_step) ?? 0,
      confidence_level: cycle.confidence_level ?? null,
      data_quality: cycle.data_quality ?? null,
      first_cc_step: firstStep,
      cc_steps: ccStepsSummary,
      multi_cc_summary: {
        cc_sold_count: numberOrNullSafe(cycle.cc_sold_count) ?? numberOrNullSafe(cycle.cc_sellable_steps_count) ?? 0,
        cc_not_sold_count: numberOrNullSafe(cycle.cc_not_sold_count) ?? numberOrNullSafe(cycle.cc_wait_steps_count) ?? 0,
        weeks_without_cc: numberOrNullSafe(cycle.weeks_without_cc) ?? 0,
        total_cc_premium_conservative: numberOrNullSafe(cycle.total_cc_premium_conservative) ?? 0,
        cc_premiums_before_recovery: numberOrNullSafe(cycle.cc_premiums_before_recovery) ?? 0,
        initial_net_cost_basis: numberOrNullSafe(cycle.initial_net_cost_basis),
        reduced_cost_basis_estimated: numberOrNullSafe(cycle.reduced_cost_basis_estimated),
        latest_cc_test_date: cycle.latest_cc_test_date ?? null,
      },
      _meta: {
        totalStepCount: steps.length,
        soldStepCount: steps.filter((step) => Number(step.cc_sold_theoretical) === 1).length,
        waitStepCount: steps.filter((step) => Number(step.cc_sold_theoretical) !== 1).length,
      },
      ...classifyAssignmentDepth({
        assigned: true,
        assigned_flag: 1,
        strike: { strike: numberOrNullSafe(cycle.assignment_strike) },
        assignment_strike: numberOrNullSafe(cycle.assignment_strike),
        assignment_price: numberOrNullSafe(cycle.assignment_price),
        resolution: {
          underlying_close_at_expiration: numberOrNullSafe(cycle.assignment_price),
          expirationClosePrice: numberOrNullSafe(cycle.assignment_price),
        },
      }),
    };
  });

  const soldFilteredCycles = mappedCycles.filter((cycle) => {
    if (normalizedSold === "all") return true;
    const soldFlag = cycle.first_cc_step?.cc_sold_theoretical;
    if (normalizedSold === "sold") return soldFlag === 1;
    if (normalizedSold === "wait") return soldFlag === 0;
    return true;
  });

  soldFilteredCycles.sort((a, b) => {
    const soldDelta = (b.first_cc_step?.cc_sold_theoretical ?? -1) - (a.first_cc_step?.cc_sold_theoretical ?? -1);
    if (soldDelta !== 0) return soldDelta;
    const thresholdDelta = (numberOrNullSafe(b.best_cc_threshold_reached) ?? -Infinity) - (numberOrNullSafe(a.best_cc_threshold_reached) ?? -Infinity);
    if (thresholdDelta !== 0) return thresholdDelta;
    const premiumDelta = (numberOrNullSafe(b.total_cc_premium_conservative) ?? -Infinity) - (numberOrNullSafe(a.total_cc_premium_conservative) ?? -Infinity);
    if (premiumDelta !== 0) return premiumDelta;
    return String(a.ticker ?? "").localeCompare(String(b.ticker ?? ""));
  });

  const limitedCycles = soldFilteredCycles.slice(0, limitValue);
  const tickers = new Set();
  let cyclesOpen = 0;
  let cyclesClosed = 0;
  let ccStepsTotal = 0;
  let ccSoldTotal = 0;
  let ccWaitTotal = 0;
  let totalCcPremiumConservative = 0;
  let reducedCostBasisSum = 0;
  let reducedCostBasisCount = 0;
  let bestThresholdGlobal = null;
  let cyclesRecovered = 0;
  let cyclesNotRecovered = 0;

  for (const cycle of limitedCycles) {
    if (cycle.ticker) tickers.add(String(cycle.ticker));
    if (String(cycle.status ?? "").toLowerCase() === "open") cyclesOpen += 1;
    else cyclesClosed += 1;
    ccStepsTotal += cycle._meta.totalStepCount;
    ccSoldTotal += cycle._meta.soldStepCount;
    ccWaitTotal += cycle._meta.waitStepCount;
    totalCcPremiumConservative += numberOrNullSafe(cycle.total_cc_premium_conservative) ?? 0;
    const reducedCostBasis = numberOrNullSafe(cycle.reduced_cost_basis_estimated);
    if (reducedCostBasis != null) {
      reducedCostBasisSum += reducedCostBasis;
      reducedCostBasisCount += 1;
    }
    const threshold = numberOrNullSafe(cycle.best_cc_threshold_reached);
    if (threshold != null && (bestThresholdGlobal == null || threshold > bestThresholdGlobal)) {
      bestThresholdGlobal = threshold;
    }
    if (cycle.assignment_recovered === 1) cyclesRecovered += 1;
    else if (cycle.assignment_recovered === 0) cyclesNotRecovered += 1;
    delete cycle._meta;
  }

  const recoveryKnownCount = cyclesRecovered + cyclesNotRecovered;
  const assignmentDepthSummary = summarizeAssignmentDepthCounts(
    limitedCycles.map((cycle) => ({
      assigned: true,
      assigned_flag: 1,
      strike: { strike: cycle.assignment_strike },
      assignment_strike: cycle.assignment_strike,
      assignment_price: cycle.assignment_price,
      resolution: {
        underlying_close_at_expiration: cycle.assignment_price,
        expirationClosePrice: cycle.assignment_price,
      },
    }))
  );

  return {
    summary: {
      cycles_total: limitedCycles.length,
      cycles_open: cyclesOpen,
      cycles_closed: cyclesClosed,
      cc_steps_total: ccStepsTotal,
      cc_sold_total: ccSoldTotal,
      cc_wait_total: ccWaitTotal,
      tickers_count: tickers.size,
      total_cc_premium_conservative: totalCcPremiumConservative,
      avg_cc_premium_conservative: limitedCycles.length > 0 ? totalCcPremiumConservative / limitedCycles.length : null,
      avg_reduced_cost_basis: reducedCostBasisCount > 0 ? reducedCostBasisSum / reducedCostBasisCount : null,
      best_threshold_global: bestThresholdGlobal,
      cycles_recovered: cyclesRecovered,
      cycles_not_recovered: cyclesNotRecovered,
      recovery_rate_pct: recoveryKnownCount > 0 ? (cyclesRecovered / recoveryKnownCount) * 100 : null,
      assignment_depth_summary: assignmentDepthSummary,
    },
    cycles: limitedCycles,
    assignment_depth_summary: assignmentDepthSummary,
  };
}

const IBKR_SHADOW_TIMEOUT_MS = 60_000;
const WHEEL_DEV_SCAN_WARNING =
  "DEV TEST - marché fermé / données possiblement figées / non tradables";
const SCAN_METRICS_NOTES = [
  "Compteurs cumulés depuis le démarrage du serveur ou le dernier reset.",
  "Compteurs Yahoo: appels réels upstream + cache hits/misses.",
  "Compteurs IBKR: approx de coût API à partir des scripts shadow read-only.",
];

/**
 * Heure "murale" America/New_York (NYSE regular session).
 * Hors jours fériés (non gérés dans cette phase).
 */
function getNyWallClockParts(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(now);
  const map = {};
  for (const p of parts) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  const hour = Number.parseInt(String(map.hour ?? "0"), 10);
  const minute = Number.parseInt(String(map.minute ?? "0"), 10);
  return {
    weekday: String(map.weekday || "").trim(),
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

/** @returns {"REGULAR" | "CLOSED_WEEKDAY" | "CLOSED_WEEKEND"} */
function getNyMarketRegime(now = new Date()) {
  const { weekday, hour, minute } = getNyWallClockParts(now);
  if (weekday === "Saturday" || weekday === "Sunday") return "CLOSED_WEEKEND";

  const weekdaySession = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].includes(weekday);
  if (!weekdaySession) return "CLOSED_WEEKDAY";

  const mins = hour * 60 + minute;
  const openM = 9 * 60 + 30;
  const closeM = 16 * 60;
  if (mins >= openM && mins < closeM) return "REGULAR";
  return "CLOSED_WEEKDAY";
}

/**
 * Résout WHEEL_DEV_SCAN : 0 / absent -> normal, 1 -> DEV forcé, auto -> DEV si marché fermé (NY).
 */
function getWheelDevScanMode(now = new Date()) {
  const rawEnv = process.env.WHEEL_DEV_SCAN;
  const raw = rawEnv == null ? "" : String(rawEnv).trim().toLowerCase();
  const configuredMode =
    raw === "1" || raw === "true" || raw === "yes" || raw === "on" ? "1" : raw === "auto" ? "auto" : "0";

  const marketRegime = getNyMarketRegime(now);

  if (configuredMode === "1") {
    return {
      configuredMode: "1",
      devScanEnabled: true,
      marketRegime,
      dataTradable: false,
      reason: "forced_dev",
    };
  }
  if (configuredMode === "0") {
    return {
      configuredMode: "0",
      devScanEnabled: false,
      marketRegime,
      dataTradable: true,
      reason: "forced_normal",
    };
  }
  const regular = marketRegime === "REGULAR";
  return {
    configuredMode: "auto",
    devScanEnabled: !regular,
    marketRegime,
    dataTradable: regular,
    reason: regular ? "auto_market_open" : "auto_market_closed",
  };
}

function createEmptyIbkrCallMetrics() {
  return {
    startedAt: new Date().toISOString(),
    lastUpdatedAt: null,
    twoPhaseEnabled: false,
    quickPremiumGateEnabled: resolveIbkrQuickPremiumGateEnabled(),
    totals: {
      totalStockQualifyCalls: 0,
      totalOptionQualifyCalls: 0,
      totalOptionChainRequests: 0,
      totalStockMarketDataRequests: 0,
      totalOptionMarketDataRequests: 0,
      totalExpectedMoveOptionRequests: 0,
      totalPutCandidateOptionRequests: 0,
      totalExpectedMoveContractsRequested: 0,
      totalPutCandidateContractsRequested: 0,
      totalPutCandidateContractsActuallyRequested: 0,
      totalPutQuotesAvoidedByQuickGate: 0,
      totalQuickGateEvaluated: 0,
      totalQuickGateSkipped: 0,
      totalQuickGateFallback: 0,
      totalQuickGatePassed: 0,
      totalQuickGateRejected: 0,
      totalQuickGateSavedApproxCalls: 0,
      totalCancelMarketDataCalls: 0,
      totalMarketDataWaits: 0,
      totalTimeouts: 0,
      totalRawStrikesChecked: 0,
      totalValidCallStrikesCount: 0,
      totalValidPutStrikesCount: 0,
      totalApproxIbkrCalls: 0,
      totalApproxCalls: 0,
      totalDurationMs: 0,
      totalTickersObserved: 0,
      totalOptionQualifyCacheHits: 0,
      totalOptionMarketDataCacheHits: 0,
      totalStockMarketDataCacheHits: 0,
      totalOptionChainCacheHits: 0,
      totalDuplicateOptionQualifyAvoided: 0,
      totalDuplicateOptionMarketDataAvoided: 0,
    },
    bySymbol: {},
    rejectionReasons: {},
  };
}

const scanMetricsState = {
  lastRefreshAt: null,
  ibkr: createEmptyIbkrCallMetrics(),
};

function incrementNumber(target, key, value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return;
  target[key] = (target[key] || 0) + n;
}

function mergeIbkrCallMetricsIntoState(metrics) {
  if (!metrics || typeof metrics !== "object") return;
  const ibkrState = scanMetricsState.ibkr;
  if (typeof metrics.twoPhaseEnabled === "boolean") {
    ibkrState.twoPhaseEnabled = metrics.twoPhaseEnabled;
  }
  if (typeof metrics.quickPremiumGateEnabled === "boolean") {
    ibkrState.quickPremiumGateEnabled = metrics.quickPremiumGateEnabled;
  }
  const sourceTotals = metrics.totals ?? {};
  const targetTotals = ibkrState.totals;
  const totalKeys = [
    "totalStockQualifyCalls",
    "totalOptionQualifyCalls",
    "totalOptionChainRequests",
    "totalStockMarketDataRequests",
    "totalOptionMarketDataRequests",
    "totalExpectedMoveOptionRequests",
    "totalPutCandidateOptionRequests",
    "totalExpectedMoveContractsRequested",
    "totalPutCandidateContractsRequested",
    "totalPutCandidateContractsActuallyRequested",
    "totalPutQuotesAvoidedByQuickGate",
    "totalQuickGateEvaluated",
    "totalQuickGateSkipped",
    "totalQuickGateFallback",
    "totalQuickGatePassed",
    "totalQuickGateRejected",
    "totalQuickGateSavedApproxCalls",
    "totalCancelMarketDataCalls",
    "totalMarketDataWaits",
    "totalTimeouts",
    "totalRawStrikesChecked",
    "totalValidCallStrikesCount",
    "totalValidPutStrikesCount",
    "totalApproxIbkrCalls",
    "totalApproxCalls",
    "totalDurationMs",
    "totalTickersObserved",
    "totalOptionQualifyCacheHits",
    "totalOptionMarketDataCacheHits",
    "totalStockMarketDataCacheHits",
    "totalOptionChainCacheHits",
    "totalDuplicateOptionQualifyAvoided",
    "totalDuplicateOptionMarketDataAvoided",
  ];
  for (const key of totalKeys) incrementNumber(targetTotals, key, sourceTotals[key]);

  const sourceRejectionReasons = metrics.rejectionReasons ?? {};
  for (const [rawReason, count] of Object.entries(sourceRejectionReasons)) {
    const reason = String(rawReason || "").trim() || "unknown";
    incrementNumber(ibkrState.rejectionReasons, reason, count);
  }

  const sourceBySymbol = metrics.bySymbol ?? {};
  for (const [rawSymbol, row] of Object.entries(sourceBySymbol)) {
    const symbol = String(rawSymbol || "").trim().toUpperCase();
    if (!symbol || !row || typeof row !== "object") continue;
    if (!ibkrState.bySymbol[symbol]) {
      ibkrState.bySymbol[symbol] = {
        stockQualifyCalls: 0,
        optionQualifyCalls: 0,
        optionChainRequests: 0,
        stockMarketDataRequests: 0,
        optionMarketDataRequests: 0,
        expectedMoveOptionRequests: 0,
        putCandidateOptionRequests: 0,
        expectedMoveContractsRequested: 0,
        putCandidateContractsRequested: 0,
        putCandidateContractsActuallyRequested: 0,
        putQuotesAvoidedByQuickGate: 0,
        quickGateEvaluated: 0,
        quickGateSkipped: 0,
        quickGateFallback: 0,
        quickGatePassed: 0,
        quickGateRejected: 0,
        quickGateSavedApproxCalls: 0,
        cancelMarketDataCalls: 0,
        marketDataWaits: 0,
        timeouts: 0,
        rawStrikesChecked: 0,
        validCallStrikesCount: 0,
        validPutStrikesCount: 0,
        durationMs: 0,
        approxIbkrCalls: 0,
        approxCalls: 0,
        totalApproxCalls: 0,
        optionQualifyCacheHits: 0,
        optionMarketDataCacheHits: 0,
        stockMarketDataCacheHits: 0,
        optionChainCacheHits: 0,
        duplicateOptionQualifyAvoided: 0,
        duplicateOptionMarketDataAvoided: 0,
        runs: 0,
        status: null,
        reason: null,
        lastDurationMs: null,
        lastUpdatedAt: null,
      };
    }
    const targetSymbol = ibkrState.bySymbol[symbol];
    const symbolKeys = [
      "stockQualifyCalls",
      "optionQualifyCalls",
      "optionChainRequests",
      "stockMarketDataRequests",
      "optionMarketDataRequests",
      "expectedMoveOptionRequests",
      "putCandidateOptionRequests",
      "expectedMoveContractsRequested",
      "putCandidateContractsRequested",
      "putCandidateContractsActuallyRequested",
      "putQuotesAvoidedByQuickGate",
      "quickGateEvaluated",
      "quickGateSkipped",
      "quickGateFallback",
      "quickGatePassed",
      "quickGateRejected",
      "quickGateSavedApproxCalls",
      "cancelMarketDataCalls",
      "marketDataWaits",
      "timeouts",
      "rawStrikesChecked",
      "validCallStrikesCount",
      "validPutStrikesCount",
      "durationMs",
      "approxIbkrCalls",
      "totalApproxCalls",
      "optionQualifyCacheHits",
      "optionMarketDataCacheHits",
      "stockMarketDataCacheHits",
      "optionChainCacheHits",
      "duplicateOptionQualifyAvoided",
      "duplicateOptionMarketDataAvoided",
    ];
    for (const key of symbolKeys) incrementNumber(targetSymbol, key, row[key]);
    targetSymbol.approxCalls = targetSymbol.approxIbkrCalls;
    targetSymbol.status = row.status ?? targetSymbol.status;
    targetSymbol.reason = row.reason ?? targetSymbol.reason;
    targetSymbol.lastDurationMs = numberOrNull(row.durationMs) ?? targetSymbol.lastDurationMs;
    targetSymbol.lastUpdatedAt = new Date().toISOString();
    targetSymbol.runs += 1;
  }
  ibkrState.lastUpdatedAt = new Date().toISOString();
}

function getScanMetricsSnapshot() {
  const yahooMetrics =
    typeof provider?.getScanMetrics === "function"
      ? provider.getScanMetrics()
      : {
          unavailable: true,
          reason: "provider_has_no_metrics",
          totals: {},
          bySymbol: {},
        };
  return {
    ok: true,
    yahoo: yahooMetrics,
    ibkr: scanMetricsState.ibkr,
    lastRefreshAt: scanMetricsState.lastRefreshAt,
    notes: SCAN_METRICS_NOTES,
  };
}

function resetScanMetricsState() {
  if (typeof provider?.resetScanMetrics === "function") {
    provider.resetScanMetrics();
  }
  scanMetricsState.ibkr = createEmptyIbkrCallMetrics();
  scanMetricsState.lastRefreshAt = new Date().toISOString();
}

const buildWatchlistBodySchema = z.object({
  maxPrice: z.union([
    z.literal(100),
    z.literal(125),
    z.literal(150),
    z.literal(200),
    z.literal(250),
  ]),
  minPrice: z.number().min(0).max(1000).optional().default(10),
  minVolume: z.number().positive(),
  maxContractCapital: z.number().positive().optional(),
  minMarketCapB: z.number().min(0).max(1_000_000).optional(),
  requireLiquidOptions: z.boolean(),
  requireWeeklyOptions: z.boolean(),
  /** Sonde optionnelle : put OTM (strike ≤ spot×(1−pct/100)) doit être liquide ; 0 = désactivé. Défaut : constante projet ou env LIQUIDITY_OTM_PROBE_PCT. */
  liquidityOtmProbePct: z.number().min(0).max(45).optional().default(defaultLiquidityOtmProbePct),
  categories: z.array(z.enum(["core", "growth", "high_premium", "etf", "weekly"])).min(1),
  limit: z.number().int().positive().max(2000).optional(),
  /** "strict" : pipeline original (tous filtres durs) ; "relaxed" : weekly/liquidity Yahoo deviennent pénalités de score. */
  watchlistMode: z.enum(["strict", "relaxed"]).optional().default("strict"),
});

const buildResearchExpandedBodySchema = z.object({
  limit: z.union([z.literal(150), z.literal(200)]).optional().default(200),
  maxPrice: z.number().positive().max(1000).optional().nullable(),
  includeAboveMaxPrice: z.boolean().optional().default(true),
  flagUnreliable: z.boolean().optional().default(true),
  categories: z
    .array(z.enum(["core", "growth", "high_premium", "etf", "weekly"]))
    .min(1)
    .optional(),
});

const mcpSessions = new Map();

function buildToolList() {
  return [
    { name: "get_quote", description: "Get a live stock quote from Yahoo Finance." },
    {
      name: "get_option_expirations",
      description: "Get available option expirations and strikes for a ticker.",
    },
    { name: "get_option_chain", description: "Get the full option chain for a ticker and expiration." },
    {
      name: "get_expected_move",
      description: "Get the expected move for a ticker using weighted ATM/strangles pricing.",
    },
    { name: "get_best_strike", description: "Find the best strike nearest a target or percent OTM." },
    { name: "get_technicals", description: "Get technical indicators and trend context from historical prices." },
    { name: "get_support_resistance", description: "Get simple support and resistance levels from historical prices." },
    {
      name: "analyze_trade_setup",
      description: "Analyze an option trade setup using expected move, technicals, and support/resistance.",
    },
  ];
}

function toMcpToolResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function createMcpServer() {
  const server = new McpServer({ name: "wheel-data-live", version: "2.0.0" });

  server.registerTool(
    "get_quote",
    {
      title: "Get Quote",
      description: "Get a live stock quote from Yahoo Finance.",
      inputSchema: { symbol: z.string().min(1) },
    },
    async ({ symbol }) =>
      toMcpToolResult(await marketService.getQuote(String(symbol).trim().toUpperCase()))
  );

  server.registerTool(
    "get_option_expirations",
    {
      title: "Get Option Expirations",
      description: "Get available option expirations and strikes for a ticker.",
      inputSchema: { symbol: z.string().min(1) },
    },
    async ({ symbol }) =>
      toMcpToolResult(await marketService.getOptionExpirations(String(symbol).trim().toUpperCase()))
  );

  server.registerTool(
    "get_option_chain",
    {
      title: "Get Option Chain",
      description: "Get the full option chain for a ticker and expiration.",
      inputSchema: {
        symbol: z.string().min(1),
        expiration: z.string().min(1),
      },
    },
    async ({ symbol, expiration }) =>
      toMcpToolResult(
        await marketService.getOptionChain(String(symbol).trim().toUpperCase(), String(expiration))
      )
  );

  server.registerTool(
    "get_expected_move",
    {
      title: "Get Expected Move",
      description: "Get the expected move for a ticker using weighted ATM/strangles pricing.",
      inputSchema: {
        symbol: z.string().min(1),
        expiration: z.string().min(1),
      },
    },
    async ({ symbol, expiration }) =>
      toMcpToolResult(
        await marketService.getExpectedMove(String(symbol).trim().toUpperCase(), String(expiration))
      )
  );

  server.registerTool(
    "get_best_strike",
    {
      title: "Get Best Strike",
      description: "Find the best strike nearest a target or percent OTM.",
      inputSchema: {
        symbol: z.string().min(1),
        expiration: z.string().min(1),
        option_type: z.enum(["call", "put"]).optional(),
        target_price: z.number().nullable().optional(),
        percent_otm: z.number().nullable().optional(),
      },
    },
    async ({ symbol, expiration, option_type, target_price, percent_otm }) =>
      toMcpToolResult(
        await marketService.getBestStrike(
          String(symbol).trim().toUpperCase(),
          String(expiration),
          option_type ?? "call",
          target_price ?? null,
          percent_otm ?? null
        )
      )
  );

  server.registerTool(
    "get_technicals",
    {
      title: "Get Technicals",
      description: "Get technical indicators and trend context from historical prices.",
      inputSchema: { symbol: z.string().min(1) },
    },
    async ({ symbol }) =>
      toMcpToolResult(await marketService.getTechnicals(String(symbol).trim().toUpperCase()))
  );

  server.registerTool(
    "get_support_resistance",
    {
      title: "Get Support Resistance",
      description: "Get simple support and resistance levels from historical prices.",
      inputSchema: { symbol: z.string().min(1) },
    },
    async ({ symbol }) =>
      toMcpToolResult(await marketService.getSupportResistance(String(symbol).trim().toUpperCase()))
  );

  server.registerTool(
    "analyze_trade_setup",
    {
      title: "Analyze Trade Setup",
      description: "Analyze an option trade setup using expected move, technicals, and support/resistance.",
      inputSchema: {
        symbol: z.string().min(1),
        expiration: z.string().min(1),
        option_type: z.enum(["call", "put"]).optional(),
        strike: z.number(),
      },
    },
    async ({ symbol, expiration, option_type, strike }) =>
      toMcpToolResult(
        await marketService.analyzeTradeSetup(
          String(symbol).trim().toUpperCase(),
          String(expiration),
          option_type ?? "put",
          strike
        )
      )
  );

  return server;
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wheel-mcp-backend", journalStore: useSqliteJournal ? "sqlite" : "json" });
});

app.get("/metrics/scan", (_req, res) => {
  res.json(getScanMetricsSnapshot());
});

// Phase 1 — ticker_scan_memory : endpoints read-only. N'altèrent rien au scan.
app.get("/ticker-scan-memory", async (req, res) => {
  try {
    const limit = toPositiveInt(req.query?.limit, 15);
    const minTests = toPositiveInt(req.query?.minTests, 3);
    const summary = await tickerScanMemoryStore.getSummary({ limit, minTests });
    res.json({ ok: true, readOnly: true, ...summary });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.get("/ticker-scan-memory/:symbol", async (req, res) => {
  try {
    const symbol = String(req.params?.symbol || "").trim().toUpperCase();
    if (!symbol) {
      return res.status(400).json({ ok: false, error: "missing_symbol" });
    }
    const record = await tickerScanMemoryStore.getSymbol(symbol);
    if (!record) {
      return res.status(404).json({ ok: false, readOnly: true, symbol, found: false });
    }
    res.json({ ok: true, readOnly: true, found: true, record });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || String(error) });
  }
});

app.post("/metrics/scan/reset", (_req, res) => {
  resetScanMetricsState();
  res.json({
    ok: true,
    resetAt: new Date().toISOString(),
    metrics: getScanMetricsSnapshot(),
  });
});

/**
 * Config de batching IBKR exposée au dashboard pour qu'il chunke en gros lots
 * (au lieu de 10 puis 5+5+5). Source de vérité unique : IBKR_SCAN_BATCH_SIZE.
 */
app.get("/ibkr/scan-config", (_req, res) => {
  res.json({
    ok: true,
    ibkrScanBatchSize: resolveIbkrScanBatchSize(),
    ibkrScanBatchSizeMin: IBKR_SCAN_BATCH_SIZE_MIN,
    ibkrScanBatchSizeMax: IBKR_SCAN_BATCH_SIZE_MAX,
    ibkrScanBatchSizeDefault: IBKR_SCAN_BATCH_SIZE_DEFAULT,
    ibkrScanConcurrency: resolveIbkrScanConcurrency(),
    source: process.env.IBKR_SCAN_BATCH_SIZE ? "env" : "default",
  });
});

app.get("/ibkr/health", async (_req, res) => {
  try {
    const body = await getIbkrHealthStatus();
    res.json(body);
  } catch (error) {
    res.json({
      ok: false,
      provider: "IBKR",
      mode: "readonly",
      readOnly: true,
      canTrade: false,
      connected: false,
      error: error?.message || String(error),
    });
  }
});

function pickIbkrShadowPython() {
  const venvPython = path.join(process.cwd(), ".venv-ibkr", "Scripts", "python.exe");
  return existsSync(venvPython) ? venvPython : "python";
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

function parseLastJsonLine(stdout) {
  const jsonLine = String(stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"))
    .pop();

  if (!jsonLine) return null;
  return JSON.parse(jsonLine);
}

function runIbkrShadowWheel(body = {}) {
  const symbol = String(body.symbol || "NVDA").trim().toUpperCase() || "NVDA";
  const expiration = body.expiration == null ? "" : String(body.expiration).trim();
  const clientId = toPositiveInt(body.clientId, toPositiveInt(process.env.IBKR_SHADOW_CLIENT_ID, 230));
  const marketDataType = toPositiveInt(body.marketDataType, 2);
  const maxStrikes = toPositiveInt(body.maxStrikes, 25);
  const debug = body.debug === true;

  const pythonExe = pickIbkrShadowPython();
  const scriptPath = path.join(process.cwd(), "python_ibkr", "test_ibkr_async_wheel_safe_aggressive.py");
  const childEnv = {
    ...process.env,
    IBKR_CLIENT_ID: String(clientId),
    IBKR_READ_ONLY: "true",
    IBKR_SYMBOL: symbol,
    IBKR_EXCHANGE: "SMART",
    IBKR_CURRENCY: "USD",
    IBKR_OPTION_PARAMS_EXCHANGE: "",
    IBKR_OPTION_RIGHT: "P",
    IBKR_MARKET_DATA_TYPE: String(marketDataType),
    IBKR_MAX_STRIKES: String(maxStrikes),
    IBKR_OPTION_EXPIRATION: expiration,
    WHEEL_DEV_SCAN: getWheelDevScanMode().devScanEnabled ? "1" : "0",
  };

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;

    const child = spawn(pythonExe, [scriptPath], {
      cwd: process.cwd(),
      env: childEnv,
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, IBKR_SHADOW_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (timedOut) {
        return resolve({
          status: 504,
          payload: {
            ok: false,
            provider: "IBKR",
            mode: "ibkr_readonly_shadow",
            error: "ibkr_shadow_timeout",
          },
        });
      }

      let payload = null;
      try {
        payload = parseLastJsonLine(stdout);
      } catch (error) {
        return reject(error);
      }

      if (!payload) {
        payload = {
          ok: false,
          provider: "IBKR",
          mode: "ibkr_readonly_shadow",
          error: "ibkr_shadow_no_json_output",
        };
        if (debug) payload._debug = { stdout, stderr, exitCode };
        return resolve({ status: 500, payload });
      }

      if (debug) payload._debug = { stdout, stderr, exitCode };
      return resolve({ status: 200, payload });
    });
  });
}

function runIbkrShadowWheelBatch(body = {}) {
  const tickers = Array.isArray(body.tickers)
    ? [...new Set(body.tickers.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))]
    : [];
  const abortSignal = body.abortSignal ?? null;
  const onAbort = typeof body.onAbort === "function" ? body.onAbort : null;
  const expiration = body.ibkrExpiration == null ? "" : String(body.ibkrExpiration).trim();
  const clientId = toPositiveInt(body.clientIdStart, toPositiveInt(process.env.IBKR_SHADOW_CLIENT_ID, 300));
  const marketDataType = toPositiveInt(body.marketDataType, 2);
  const maxStrikes = toPositiveInt(body.maxStrikes, 25);
  const perTickerTimeoutMs = Math.max(1000, toPositiveInt(body.perTickerTimeoutMs, 7000));
  const requestedTimeoutMs = toPositiveInt(body.batchTimeoutMs, 0);
  const debug = body.debug === true;
  const twoPhaseScanEnabled = resolveIbkrTwoPhaseScanEnabled();
  const scanConcurrency = resolveIbkrScanConcurrency();

  const pythonExe = pickIbkrShadowPython();
  const scriptPath = path.join(process.cwd(), "python_ibkr", "test_ibkr_async_wheel_safe_aggressive_batch.py");
  const childEnv = {
    ...process.env,
    IBKR_CLIENT_ID: String(clientId),
    IBKR_READ_ONLY: "true",
    IBKR_SYMBOLS_JSON: JSON.stringify(tickers),
    IBKR_EXCHANGE: "SMART",
    IBKR_CURRENCY: "USD",
    IBKR_OPTION_PARAMS_EXCHANGE: "",
    IBKR_OPTION_RIGHT: "P",
    IBKR_MARKET_DATA_TYPE: String(marketDataType),
    IBKR_MAX_STRIKES: String(maxStrikes),
    IBKR_OPTION_EXPIRATION: expiration,
    IBKR_PER_TICKER_TIMEOUT_MS: String(perTickerTimeoutMs),
    IBKR_TWO_PHASE_SCAN: twoPhaseScanEnabled ? "1" : "0",
    IBKR_SCAN_CONCURRENCY: String(scanConcurrency),
    WHEEL_DEV_SCAN: getWheelDevScanMode().devScanEnabled ? "1" : "0",
  };
  const timeoutMs = requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : Math.max(IBKR_SHADOW_TIMEOUT_MS, perTickerTimeoutMs * Math.max(tickers.length, 1) + 20_000);

  console.log(
    "[IBKR PERF] spawning batch symbols=" + tickers.length + " concurrency=" + scanConcurrency
  );

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let finished = false;
    let timedOut = false;
    let aborted = false;

    const child = spawn(pythonExe, [scriptPath], {
      cwd: process.cwd(),
      env: childEnv,
      windowsHide: true,
    });

    const killChild = (reason) => {
      if (child.exitCode != null || child.killed) return;
      console.warn("[IBKR_SHADOW_BATCH_CHILD_KILL]", reason, "pid", child.pid ?? "unknown");
      try {
        child.kill();
      } catch {
        // no-op: child may already be exiting
      }
    };

    const handleAbort = () => {
      if (finished || aborted) return;
      aborted = true;
      try {
        onAbort?.();
      } catch {
        // no-op: abort callbacks are best-effort only
      }
      killChild("abort_signal");
    };

    let detachAbort = () => {};
    if (abortSignal && typeof abortSignal.addEventListener === "function") {
      if (abortSignal.aborted) {
        handleAbort();
      } else {
        const abortListener = () => handleAbort();
        abortSignal.addEventListener("abort", abortListener, { once: true });
        detachAbort = () => {
          abortSignal.removeEventListener("abort", abortListener);
        };
      }
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killChild("global_timeout");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      detachAbort();
      reject(error);
    });

    child.on("close", (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      detachAbort();

      if (aborted) {
        return resolve({
          status: 499,
          payload: {
            ok: false,
            provider: "IBKR",
            mode: "ibkr_readonly_shadow_batch",
            error: "ibkr_shadow_batch_aborted",
            results: [],
          },
        });
      }

      if (timedOut) {
        return resolve({
          status: 504,
          payload: {
            ok: false,
            provider: "IBKR",
            mode: "ibkr_readonly_shadow_batch",
            error: "ibkr_shadow_batch_timeout",
            results: [],
          },
        });
      }

      let payload = null;
      try {
        payload = parseLastJsonLine(stdout);
      } catch (error) {
        return reject(error);
      }

      if (!payload) {
        console.warn(
          "[IBKR PERF] batch_no_json_output exitCode=" + exitCode +
            " stderrTail=" + JSON.stringify(String(stderr).slice(-1500)) +
            " stdoutTail=" + JSON.stringify(String(stdout).slice(-400))
        );
        payload = {
          ok: false,
          provider: "IBKR",
          mode: "ibkr_readonly_shadow_batch",
          error: "ibkr_shadow_batch_no_json_output",
          results: [],
        };
        if (debug) payload._debug = { stdout, stderr, exitCode };
        return resolve({ status: 500, payload });
      }

      if (typeof payload.twoPhaseEnabled !== "boolean") {
        payload.twoPhaseEnabled = twoPhaseScanEnabled;
      }
      if (typeof payload.progressiveSafeScanEnabled !== "boolean") {
        payload.progressiveSafeScanEnabled = resolveIbkrProgressiveSafeScanEnabled();
      }
      if (!Number.isFinite(Number(payload.maxValidPutsEffective))) {
        payload.maxValidPutsEffective = resolveIbkrProgressiveSafeScanMaxValidPuts();
      }
      if (debug) payload._debug = { stdout, stderr, exitCode };
      return resolve({ status: 200, payload });
    });
  });
}

function ymdDashedToCompact(value) {
  const s = String(value || "").trim();
  const match = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}${match[2]}${match[3]}` : s;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function diffOrNull(left, right) {
  const a = numberOrNull(left);
  const b = numberOrNull(right);
  return a == null || b == null ? null : a - b;
}

function sameStrikeOrNull(left, right) {
  const a = numberOrNull(left?.strike);
  const b = numberOrNull(right?.strike);
  return a == null || b == null ? null : Math.abs(a - b) < 1e-9;
}

function buildWheelShadowComparison(yahoo, ibkr) {
  return {
    underlyingPriceDiff: diffOrNull(yahoo?.currentPrice, ibkr?.underlyingPrice),
    expectedMoveDiff: diffOrNull(yahoo?.expectedMove, ibkr?.expectedMove),
    lowerBoundDiff: diffOrNull(yahoo?.lowerBound, ibkr?.lowerBound),
    aggressiveStrikeDiff: diffOrNull(yahoo?.aggressiveStrike?.strike, ibkr?.aggressiveStrike?.strike),
    safeStrikeDiff: diffOrNull(yahoo?.safeStrike?.strike, ibkr?.safeStrike?.strike),
    sameAggressiveStrike: sameStrikeOrNull(yahoo?.aggressiveStrike, ibkr?.aggressiveStrike),
    sameSafeStrike: sameStrikeOrNull(yahoo?.safeStrike, ibkr?.safeStrike),
  };
}

function getIbkrScanReason(row) {
  if (!row?.ok) return row?.reason || row?.error || "ibkr_unavailable";
  if (!row?.safeStrike && !row?.aggressiveStrike) {
    return row?.safeSelectionReason || "no_safe_or_aggressive_strike";
  }
  if (!row?.safeStrike) return row?.safeSelectionReason || "no_safe_candidate_meets_min_premium";
  if (!row?.aggressiveStrike) return "no_aggressive_strike";
  return null;
}

function getIbkrTickerStatus(row) {
  const reason = getIbkrScanReason(row);
  if (String(row?.reason || reason || "").toLowerCase().includes("timeout")) return "timeout";
  if (row?.ok !== true) return "error";
  return reason ? "rejected" : "kept";
}

function incrementReasonCount(target, reason) {
  const key = String(reason || "unknown").trim() || "unknown";
  target[key] = (target[key] || 0) + 1;
}

function buildIbkrRejectionReasons(rows) {
  const rejectionReasons = {};
  for (const row of rows) {
    const status = getIbkrTickerStatus(row);
    if (status === "kept") continue;
    incrementReasonCount(rejectionReasons, getIbkrScanReason(row) || status);
  }
  return rejectionReasons;
}

function buildIbkrTickerMetricRow(row) {
  const metrics = row?.ibkrCallMetrics && typeof row.ibkrCallMetrics === "object" ? row.ibkrCallMetrics : {};
  const status = getIbkrTickerStatus(row);
  const reason = getIbkrScanReason(row);
  const approxIbkrCalls = numberOrNull(metrics.approxIbkrCalls ?? metrics.totalApproxCalls ?? metrics.approxCalls) ?? 0;
  return {
    ...metrics,
    symbol: String(row?.symbol || "").trim().toUpperCase(),
    twoPhaseEnabled: Boolean(row?.twoPhaseEnabled),
    status,
    reason: reason || (status === "kept" ? "OK" : status),
    durationMs: numberOrNull(row?.durationMs ?? metrics.durationMs),
    approxIbkrCalls,
    approxCalls: approxIbkrCalls,
    totalApproxCalls: approxIbkrCalls,
  };
}

/** Observabilité seulement : enrichit les rejets IBKR Shadow (pas de logique métier). */
function roundFiniteObservation(value, decimals = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return +n.toFixed(decimals);
}

function ibkrShadowPutOtmPctFromUnderlying(underlying, strike) {
  const u = numberOrNull(underlying);
  const k = numberOrNull(strike);
  if (u == null || k == null || u <= 0) return null;
  return roundFiniteObservation(((u - k) / u) * 100, 4);
}

function yieldPctFromPythonPremiumYieldFraction(premiumYieldFrac) {
  const f = numberOrNull(premiumYieldFrac);
  if (f == null) return null;
  return roundFiniteObservation(f * 100, 6);
}

function summarizeIbkrShadowPutForensicThin(p) {
  if (!p || typeof p !== "object") return null;
  const tgt = numberOrNull(p.targetPremium);
  const pu = numberOrNull(p.primeUsed);
  return {
    strike: numberOrNull(p.strike),
    bid: roundFiniteObservation(p.bid),
    ask: roundFiniteObservation(p.ask),
    mid: roundFiniteObservation(p.mid),
    primeUsed: roundFiniteObservation(p.primeUsed),
    spreadPct: roundFiniteObservation(p.spreadPct),
    premiumYieldPct: yieldPctFromPythonPremiumYieldFraction(p.premiumYield),
    passesMinPremium: p.passesMinPremium === true ? true : p.passesMinPremium === false ? false : null,
    isBelowLowerBound: p.isBelowLowerBound === true ? true : p.isBelowLowerBound === false ? false : null,
    distanceBelowLowerBound: roundFiniteObservation(p.distanceBelowLowerBound),
    premiumVsTarget: roundFiniteObservation(p.premiumVsTarget),
    premiumCoveragePct:
      tgt != null && tgt > 0 && pu != null ? roundFiniteObservation((pu / tgt) * 100, 4) : null,
    status: p.status ?? null,
    reason: p.reason ?? null,
  };
}

function pickBestIbkrShadowSafeNearMissPut(row) {
  const puts = Array.isArray(row?.putCandidates) ? row.putCandidates : [];
  const aggStrike =
    row?.aggressiveStrike && typeof row.aggressiveStrike === "object"
      ? numberOrNull(row.aggressiveStrike.strike)
      : null;
  const pool = [];
  for (const p of puts) {
    if (!p || typeof p !== "object") continue;
    if (p.isBelowLowerBound !== true) continue;
    const k = numberOrNull(p.strike);
    if (k == null) continue;
    if (aggStrike != null && k >= aggStrike) continue;
    if (p.bid == null || p.ask == null || p.mid == null || !(Number(p.mid) > 0)) continue;
    pool.push(p);
  }
  if (!pool.length) {
    const relaxed = [];
    for (const p of puts) {
      if (!p || typeof p !== "object") continue;
      if (p.isBelowLowerBound !== true) continue;
      const k = numberOrNull(p.strike);
      if (k == null) continue;
      if (p.bid == null || p.ask == null || p.mid == null || !(Number(p.mid) > 0)) continue;
      relaxed.push(p);
    }
    pool.push(...relaxed);
  }
  if (!pool.length) return null;
  let best = pool[0];
  let bestPu = numberOrNull(best.primeUsed);
  for (let i = 1; i < pool.length; i++) {
    const p = pool[i];
    const pr = numberOrNull(p.primeUsed);
    if (pr == null) continue;
    if (bestPu == null || pr > bestPu) {
      best = p;
      bestPu = pr;
      continue;
    }
    if (bestPu != null && pr === bestPu) {
      const ks = numberOrNull(best.strike) ?? -Infinity;
      const kn = numberOrNull(p.strike) ?? -Infinity;
      if (kn > ks) best = p;
    }
  }
  return best;
}

function summarizeAggressiveStrikeForensics(aggObj, underlying) {
  const empty = {
    aggressiveBid: null,
    aggressiveAsk: null,
    aggressiveMid: null,
    aggressivePrimeUsed: null,
    aggressiveSpreadPct: null,
    aggressiveYieldPct: null,
    aggressiveOtmPct: null,
    aggressiveDistanceFromLowerBound: null,
  };
  if (!aggObj || typeof aggObj !== "object") return empty;
  const strikeNum = numberOrNull(aggObj.strike);
  return {
    aggressiveBid: roundFiniteObservation(aggObj.bid),
    aggressiveAsk: roundFiniteObservation(aggObj.ask),
    aggressiveMid: roundFiniteObservation(aggObj.mid),
    aggressivePrimeUsed: roundFiniteObservation(aggObj.primeUsed),
    aggressiveSpreadPct: roundFiniteObservation(aggObj.spreadPct),
    aggressiveYieldPct: yieldPctFromPythonPremiumYieldFraction(aggObj.premiumYield),
    aggressiveOtmPct: ibkrShadowPutOtmPctFromUnderlying(underlying, strikeNum),
    aggressiveDistanceFromLowerBound: roundFiniteObservation(aggObj.distanceBelowLowerBound),
  };
}

function summarizeBestSafeNearMissForensics(best, underlying, targetPremiumRaw) {
  const empty = {
    bestSafeStrike: null,
    bestSafeBid: null,
    bestSafeAsk: null,
    bestSafeMid: null,
    bestSafePrimeUsed: null,
    bestSafeSpreadPct: null,
    bestSafeYieldPct: null,
    bestSafeOtmPct: null,
    bestSafeDistanceFromLowerBound: null,
    premiumDeficitDollar: null,
    premiumDeficitPct: null,
    premiumCoveragePct: null,
  };
  if (!best || typeof best !== "object") return empty;
  const strikeNum = numberOrNull(best.strike);
  const prime = roundFiniteObservation(best.primeUsed);
  const tgt = numberOrNull(targetPremiumRaw);
  let premiumDeficitDollar = null;
  let premiumDeficitPct = null;
  let premiumCoveragePct = null;
  if (tgt != null && prime != null) {
    premiumDeficitDollar = roundFiniteObservation(tgt - prime, 6);
    if (tgt > 0) {
      premiumDeficitPct = roundFiniteObservation(((tgt - prime) / tgt) * 100, 4);
      premiumCoveragePct = roundFiniteObservation((prime / tgt) * 100, 4);
    }
  }
  return {
    bestSafeStrike: strikeNum,
    bestSafeBid: roundFiniteObservation(best.bid),
    bestSafeAsk: roundFiniteObservation(best.ask),
    bestSafeMid: roundFiniteObservation(best.mid),
    bestSafePrimeUsed: prime,
    bestSafeSpreadPct: roundFiniteObservation(best.spreadPct),
    bestSafeYieldPct: yieldPctFromPythonPremiumYieldFraction(best.premiumYield),
    bestSafeOtmPct: ibkrShadowPutOtmPctFromUnderlying(underlying, strikeNum),
    bestSafeDistanceFromLowerBound: roundFiniteObservation(best.distanceBelowLowerBound),
    premiumDeficitDollar,
    premiumDeficitPct,
    premiumCoveragePct,
  };
}

function buildTopPutCandidatesForensicSummary(row, limit = 5) {
  const puts = Array.isArray(row?.putCandidates) ? row.putCandidates : [];
  const ranked = [...puts].filter((p) => numberOrNull(p?.primeUsed) != null);
  ranked.sort((a, b) => numberOrNull(b.primeUsed) - numberOrNull(a.primeUsed));
  const out = [];
  for (const p of ranked.slice(0, limit)) {
    const s = summarizeIbkrShadowPutForensicThin(p);
    if (s) out.push(s);
  }
  return out;
}

function buildIbkrShadowRejectedForensics(row, rejectionReasonCode) {
  const underlyingRaw = row?.underlyingPrice;
  const targetRaw = row?.targetPremium;
  const bestNear = pickBestIbkrShadowSafeNearMissPut(row);
  const aggObj =
    row?.aggressiveStrike && typeof row.aggressiveStrike === "object" ? row.aggressiveStrike : null;
  return {
    rejectionReason: rejectionReasonCode ?? null,
    underlyingPrice: roundFiniteObservation(row?.underlyingPrice, 6),
    lowerBound: roundFiniteObservation(row?.lowerBound, 6),
    targetPremium: roundFiniteObservation(row?.targetPremium, 6),
    ...summarizeAggressiveStrikeForensics(aggObj, underlyingRaw),
    ...summarizeBestSafeNearMissForensics(bestNear, underlyingRaw, targetRaw),
    putCandidatesCount: Array.isArray(row?.putCandidates) ? row.putCandidates.length : 0,
    topPutCandidatesSummary: buildTopPutCandidatesForensicSummary(row, 5),
    probabilityOfProfit: null,
  };
}

function computePercentile(sortedNumbers, percentile) {
  if (!Array.isArray(sortedNumbers) || sortedNumbers.length === 0) return null;
  const p = Math.max(0, Math.min(100, Number(percentile)));
  const idx = Math.ceil((p / 100) * sortedNumbers.length) - 1;
  const boundedIdx = Math.max(0, Math.min(sortedNumbers.length - 1, idx));
  return sortedNumbers[boundedIdx];
}

function buildIbkrPerformanceSummary(rows, payloadDurationMs = null, serverDurationMs = null, limit = 10) {
  const metricRows = (Array.isArray(rows) ? rows : [])
    .map((row) => buildIbkrTickerMetricRow(row))
    .filter((row) => row?.symbol);
  const withDuration = metricRows.filter((row) => Number.isFinite(numberOrNull(row.durationMs)));
  const durations = withDuration
    .map((row) => numberOrNull(row.durationMs))
    .filter((v) => v != null)
    .sort((a, b) => a - b);
  const avgDurationMs = durations.length
    ? Math.round(durations.reduce((acc, value) => acc + value, 0) / durations.length)
    : null;
  const medianDurationMs = computePercentile(durations, 50);
  const p95DurationMs = computePercentile(durations, 95);
  const slowestTickers = [...withDuration]
    .sort((a, b) => Number(b.durationMs || 0) - Number(a.durationMs || 0))
    .slice(0, Math.max(1, limit))
    .map((row) => ({
      symbol: row.symbol,
      status: row.status,
      reason: row.reason,
      durationMs: numberOrNull(row.durationMs),
      approxCalls: numberOrNull(row.approxCalls),
      timeouts: numberOrNull(row.timeouts) ?? 0,
      kept: row.status === "kept",
      rejected: row.status !== "kept",
    }));
  const keptCount = metricRows.filter((row) => row.status === "kept").length;
  const rejectedCount = metricRows.length - keptCount;
  const timeoutCount = metricRows.reduce(
    (acc, row) =>
      acc + (String(row.status || "").toLowerCase() === "timeout" ? 1 : (numberOrNull(row.timeouts) ?? 0) > 0 ? 1 : 0),
    0
  );
  return {
    scannedRows: metricRows.length,
    rowsWithDuration: durations.length,
    keptCount,
    rejectedCount,
    timeoutCount,
    avgDurationMs,
    medianDurationMs,
    p95DurationMs,
    batchDurationMs: numberOrNull(payloadDurationMs),
    serverDurationMs: numberOrNull(serverDurationMs),
    slowestTickers,
  };
}

function enrichIbkrCallMetrics(metrics, rows, rejectionReasons) {
  const source = metrics && typeof metrics === "object" ? metrics : {};
  const bySymbol = { ...(source.bySymbol ?? {}) };
  for (const row of rows) {
    const symbol = String(row?.symbol || "").trim().toUpperCase();
    if (!symbol) continue;
    bySymbol[symbol] = {
      ...(bySymbol[symbol] ?? {}),
      ...buildIbkrTickerMetricRow(row),
    };
  }
  return {
    ...source,
    totals: source.totals ?? {},
    bySymbol,
    rejectionReasons: {
      ...(source.rejectionReasons ?? {}),
      ...rejectionReasons,
    },
  };
}

function getIbkrStrikeYield(strike) {
  const n = numberOrNull(strike?.premiumYield ?? strike?.premiumYieldOnUnderlying);
  return n == null ? null : n;
}

/** Calcule le DTE en jours depuis la date d'aujourd'hui vers une expiration "YYYYMMDD" ou "YYYY-MM-DD". */
function dteDaysFromIbkrExpiration(expStr) {
  if (!expStr) return null;
  const clean = String(expStr).replace(/-/g, "");
  if (!/^\d{8}$/.test(clean)) return null;
  const exp = new Date(`${clean.slice(0, 4)}-${clean.slice(4, 6)}-${clean.slice(6, 8)}T00:00:00Z`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const days = Math.round((exp.getTime() - today.getTime()) / 86400000);
  return days > 0 ? days : null;
}

const ELITE_STABLE_SECTORS = new Set([
  "Utilities",
  "Consumer Defensive",
  "Healthcare",
  "Communication Services",
  "Financial Services",
]);
const ELITE_CYCLICAL_SECTORS = new Set([
  "Energy",
  "Basic Materials",
  "Industrials",
  "Consumer Cyclical",
  "Real Estate",
]);
const ELITE_ETF_SYMBOLS = new Set([
  "SPY", "QQQ", "IWM", "DIA", "XLF", "XLE", "XLV", "XLI", "XLP", "XLU", "SOXL", "TQQQ",
]);

function clamp01(value) {
  const n = toNumber(value);
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeSpreadPct(rawSpreadPct) {
  const spread = numberOrNull(rawSpreadPct);
  if (spread == null) return null;
  return spread > 1 ? spread / 100 : spread;
}

function buildEliteFinalScore(cand, row) {
  const reasonsUp = [];
  const reasonsDown = [];
  let score = 50;

  const annualizedYield = numberOrNull(cand?.annualizedYield);
  if (annualizedYield != null) {
    const capped = Math.min(annualizedYield, 1.2);
    const yieldBonus = clamp01(capped / 0.8) * 14;
    score += yieldBonus;
    if (annualizedYield >= 0.35) reasonsUp.push("premium annualisé élevé");
    if (annualizedYield > 0.7) {
      const toxicMildPenalty = clamp01((annualizedYield - 0.7) / 0.3) * 4;
      score -= toxicMildPenalty;
      reasonsDown.push("prime possiblement gonflée");
    }
    if (annualizedYield > 1.0) {
      const toxicStrongPenalty = 4 + clamp01((annualizedYield - 1.0) / 0.4) * 6;
      score -= toxicStrongPenalty;
      reasonsDown.push("prime possiblement gonflée");
    }
  } else {
    score -= 8;
    reasonsDown.push("yield non disponible");
  }

  const spread = normalizeSpreadPct(cand?.spreadPct ?? cand?.safeStrike?.spreadPct);
  if (spread != null) {
    const spreadPenalty = clamp01(spread / 0.35) * 26;
    score -= spreadPenalty;
    if (spread <= 0.08) reasonsUp.push("spread faible");
    if (spread > 0.2) reasonsDown.push("spread large");
  } else {
    score -= 10;
    reasonsDown.push("spread non disponible");
  }

  const safeVolume = toNumber(cand?.safeStrike?.volume ?? 0);
  const safeOi = toNumber(cand?.safeStrike?.openInterest ?? 0);
  const liqScore = clamp01(safeVolume / 500) * 5 + clamp01(safeOi / 1200) * 7;
  score += liqScore;
  if (safeVolume >= 100 && safeOi >= 500) reasonsUp.push("liquidité option robuste");
  if (safeVolume < 20 || safeOi < 80) reasonsDown.push("liquidité option faible");

  const distancePctAbs = Math.abs(toNumber(cand?.safeStrike?.distancePct ?? 0));
  if (distancePctAbs > 0) {
    if (distancePctAbs >= 4 && distancePctAbs <= 12) {
      score += 7;
      reasonsUp.push("distance strike sécuritaire");
    } else if (distancePctAbs > 18) {
      score -= 4;
      reasonsDown.push("distance strike excessive");
    } else if (distancePctAbs < 2) {
      score -= 6;
      reasonsDown.push("strike trop proche du spot");
    }
  }

  const lowerBound = numberOrNull(cand?.lowerBound);
  const safeStrike = numberOrNull(cand?.safeStrike?.strike);
  if (lowerBound != null && safeStrike != null) {
    if (safeStrike <= lowerBound) {
      score += 6;
      reasonsUp.push("cohérence expected move");
    } else {
      score -= 6;
      reasonsDown.push("strike au-dessus de la borne basse");
    }
  }

  const hasEarningsRisk =
    row?.hasUpcomingEarningsBeforeExpiration === true ||
    row?.hasEarningsBeforeExpiration === true ||
    (Number.isFinite(Number(row?.earningsDaysUntil)) && Number(row.earningsDaysUntil) <= 1);
  if (hasEarningsRisk) {
    score -= 18;
    reasonsDown.push("earnings proches");
  }

  const spot = numberOrNull(cand?.underlyingPrice ?? cand?.currentPrice);
  const expectedMove = numberOrNull(cand?.expectedMove);
  if (spot != null && spot > 0 && expectedMove != null && expectedMove > 0) {
    const emPct = expectedMove / spot;
    if (emPct >= 0.2) {
      score -= 20;
      reasonsDown.push("volatilite extreme");
    } else if (emPct >= 0.14) {
      score -= 14;
      reasonsDown.push("volatilité excessive");
    } else if (emPct <= 0.06) {
      score += 4;
      reasonsUp.push("volatilité maîtrisée");
    }
  }

  const quoteTypeForMarketCap = String(row?.quote?.quoteType || row?.quoteType || "").toUpperCase();
  const symbolForMarketCap = String(cand?.symbol || row?.symbol || "").toUpperCase();
  const isEtfLikeForMarketCap =
    quoteTypeForMarketCap === "ETF" || ELITE_ETF_SYMBOLS.has(symbolForMarketCap);
  const marketCap =
    numberOrNull(row?.quote?.marketCap) ??
    numberOrNull(row?.marketCap) ??
    numberOrNull(cand?.raw?.quote?.marketCap);
  if (marketCap != null) {
    if (marketCap >= 50_000_000_000) {
      score += 8;
      reasonsUp.push("large cap");
    } else if (marketCap < 5_000_000_000) {
      score -= 12;
      reasonsDown.push("small cap");
    }
  } else if (!isEtfLikeForMarketCap) {
    score -= 6;
    reasonsDown.push("market cap inconnue");
  }

  const avgVolume =
    numberOrNull(row?.quote?.averageDailyVolume3Month) ??
    numberOrNull(row?.quote?.regularMarketVolume) ??
    numberOrNull(row?.volume);
  if (avgVolume != null) {
    if (avgVolume >= 8_000_000) {
      score += 6;
      reasonsUp.push("volume élevé");
    } else if (avgVolume < 1_500_000) {
      score -= 5;
      reasonsDown.push("volume limité");
    }
  }

  const sector = String(row?.quote?.sector || row?.sector || "").trim();
  if (sector) {
    if (ELITE_STABLE_SECTORS.has(sector)) {
      score += 3;
      reasonsUp.push("secteur stable");
    } else if (ELITE_CYCLICAL_SECTORS.has(sector)) {
      score -= 3;
      reasonsDown.push("fragilité cyclique");
    }
  }

  const quoteType = String(row?.quote?.quoteType || row?.quoteType || "").toUpperCase();
  const symbol = String(cand?.symbol || row?.symbol || "").toUpperCase();
  if (quoteType === "ETF" || ELITE_ETF_SYMBOLS.has(symbol)) {
    score += 4;
    reasonsUp.push("bonus ETF");
  }

  const supportStatus = String(row?.supportStatus || row?.supportResistance?.supportStatus || "");
  if (supportStatus.includes("below_support") || supportStatus === "near_support") {
    score += 6;
    reasonsUp.push("support favorable");
  } else if (supportStatus.includes("above_support") || supportStatus === "current_below_support") {
    score -= 8;
    reasonsDown.push("support fragile");
  }

  const eliteScore = Math.max(0, Math.min(100, Math.round(score * 10) / 10));
  let eliteBadge = "Moderate";
  if (eliteScore >= 82) eliteBadge = "Elite";
  else if (eliteScore >= 68) eliteBadge = "Strong";
  else if (eliteScore < 52) eliteBadge = "Speculative";

  return {
    eliteScore,
    eliteBadge,
    scoreBreakdown: {
      annualizedYield: annualizedYield ?? null,
      spreadPct: spread == null ? null : spread * 100,
      optionVolume: safeVolume || null,
      optionOpenInterest: safeOi || null,
      distancePctAbs: distancePctAbs || null,
      marketCap: marketCap ?? null,
      averageVolume: avgVolume ?? null,
      expectedMove: expectedMove ?? null,
      earningsRisk: hasEarningsRisk,
      sector: sector || null,
    },
    strengths: [...new Set(reasonsUp)].slice(0, 6),
    weaknesses: [...new Set(reasonsDown)].slice(0, 6),
  };
}

function ibkrMarketDataTypeLabel(value) {
  switch (Number(value)) {
    case 1:
      return "live";
    case 2:
      return "frozen";
    case 3:
      return "delayed";
    case 4:
      return "delayed_frozen";
    default:
      return "unknown";
  }
}

function toIbkrScanCandidate(row, devScanEnabled = false) {
  const safe = row?.safeStrike ?? null;
  const aggressive = row?.aggressiveStrike ?? null;
  const primary = safe ?? aggressive;
  const weeklyYield = getIbkrStrikeYield(primary);
  const rowDteDays = dteDaysFromIbkrExpiration(row.expiration);
  // DTE-ajusté si l'expiration est connue ; fallback ×52 (assume hebdomadaire) sinon
  const annualizedYield =
    weeklyYield == null
      ? null
      : rowDteDays != null && rowDteDays > 0
      ? weeklyYield * (365 / rowDteDays)
      : weeklyYield * 52;
  /** @type {Record<string, unknown>} */
  const cand = {
    symbol: row.symbol,
    currentPrice: row.underlyingPrice ?? null,
    underlyingPrice: row.underlyingPrice ?? null,
    expectedMove: row.expectedMove ?? null,
    lowerBound: row.lowerBound ?? null,
    upperBound: row.upperBound ?? null,
    targetPremium: row.targetPremium ?? null,
    safeStrike: safe,
    aggressiveStrike: aggressive,
    spread: primary?.spread ?? null,
    spreadPct: primary?.spreadPct ?? null,
    premiumUsed: primary?.primeUsed ?? null,
    weeklyYield,
    annualizedYield,
    putCandidates: Array.isArray(row.putCandidates) ? row.putCandidates : [],
    safeSpreadRescue: row?.safeSpreadRescue ?? null,
    putCandidatesSummary: {
      total: Array.isArray(row.putCandidates) ? row.putCandidates.length : 0,
      kept: Array.isArray(row.putCandidates)
        ? row.putCandidates.filter((put) => put?.status === "kept" || String(put?.status || "").includes("selected")).length
        : 0,
    },
    qualityReasons: [
      row.safeStrike ? "safe IBKR disponible" : "safe IBKR absent",
      row.aggressiveStrike ? "agressif IBKR disponible" : "agressif IBKR absent",
    ],
    durationMs: row.durationMs ?? null,
    status: "kept",
    reason: "OK",
    ibkrCallMetrics: buildIbkrTickerMetricRow(row),
    source: "IBKR",
    marketDataTypeRequested: row?.marketDataTypeRequested ?? null,
    marketDataTypeRequestedLabel:
      row?.marketDataTypeRequestedLabel ?? ibkrMarketDataTypeLabel(row?.marketDataTypeRequested),
    marketDataTypeReceived: row?.marketDataTypeReceived ?? null,
    marketDataTypeReceivedLabel:
      row?.marketDataTypeReceivedLabel ?? ibkrMarketDataTypeLabel(row?.marketDataTypeReceived),
    scanCompletedAt: row?.scanCompletedAt ?? null,
    raw: row,
  };
  if (devScanEnabled) {
    cand.devScanEnabled = true;
    cand.dataTradable = false;
    if (row?.devIncompleteMarketData === true) cand.devIncompleteMarketData = true;
    const devNote = "Données IBKR incomplètes - affichage DEV seulement";
    const qual = cand.qualityReasons.filter(Boolean);
    if (Array.isArray(row?.qualityReasons)) {
      for (const qr of row.qualityReasons) {
        const s = String(qr || "").trim();
        if (s && !qual.includes(s)) qual.push(s);
      }
    }
    if (!qual.some((x) => String(x).includes("DEV"))) {
      qual.push(devNote);
    }
    cand.qualityReasons = qual;
    cand.ibkrShadowCardMode = cand.devIncompleteMarketData === true ? "dev_incomplete" : "dev_nominal";
  }
  const elite = buildEliteFinalScore(cand, row);
  cand.eliteScore = elite.eliteScore;
  cand.eliteBadge = elite.eliteBadge;
  cand.scoreBreakdown = elite.scoreBreakdown;
  cand.strengths = elite.strengths;
  cand.weaknesses = elite.weaknesses;
  return cand;
}

function toIbkrScanDevCandidate(row, devScanEnabled = false) {
  const mapped = { ...toIbkrScanCandidate(row, devScanEnabled) };
  mapped.status = "dev_display";
  const reasonText = getIbkrScanReason(row) ?? row?.error ?? row?.reason ?? "ibkr_dev_display";
  mapped.reason =
    typeof reasonText === "string" && reasonText.trim() !== ""
      ? reasonText.trim()
      : "ibkr_dev_display";
  const qual = [...(mapped.qualityReasons ?? []).filter(Boolean)];
  const tag = WHEEL_DEV_SCAN_WARNING;
  if (!qual.some((x) => String(x).includes(tag))) qual.push(tag);
  mapped.qualityReasons = qual;
  return mapped;
}

function compareIbkrScanCandidates(a, b, sort) {
  if (sort === "elite") {
    const eliteDiff = toNumber(b?.eliteScore) - toNumber(a?.eliteScore);
    if (eliteDiff !== 0) return eliteDiff;
  }
  if (sort === "yield") {
    return toNumber(b?.annualizedYield) - toNumber(a?.annualizedYield);
  }
  const aSafe = a?.safeStrike ? 1 : 0;
  const bSafe = b?.safeStrike ? 1 : 0;
  if (aSafe !== bSafe) return bSafe - aSafe;
  const aSpread = numberOrNull(a?.spreadPct);
  const bSpread = numberOrNull(b?.spreadPct);
  if (aSpread != null && bSpread != null && aSpread !== bSpread) return aSpread - bSpread;
  if (aSpread == null && bSpread != null) return 1;
  if (aSpread != null && bSpread == null) return -1;
  return toNumber(b?.annualizedYield) - toNumber(a?.annualizedYield);
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function compareWheelShadowForSymbol({
  symbol,
  expiration,
  ibkrExpiration,
  clientId,
  marketDataType,
  maxStrikes,
  debug,
}) {
  const warnings = [];

  let yahoo = null;
  try {
    yahoo = await wheelScanner.scanTicker(symbol, expiration);
    if (!yahoo?.ok) {
      yahoo = { ok: false, symbol, expiration, error: yahoo?.reason || yahoo?.error || "yahoo_compare_failed" };
      warnings.push("Yahoo compare failed");
    }
  } catch (error) {
    yahoo = { ok: false, symbol, expiration, error: error?.message || String(error) };
    warnings.push("Yahoo compare failed");
  }

  let ibkr = null;
  try {
    const ibkrResult = await runIbkrShadowWheel({
      symbol,
      expiration: ibkrExpiration,
      clientId,
      marketDataType,
      maxStrikes,
      debug,
    });
    ibkr = ibkrResult.payload;
    if (!ibkr?.ok) warnings.push("IBKR Shadow compare failed");
  } catch (error) {
    ibkr = {
      ok: false,
      provider: "IBKR",
      mode: "ibkr_readonly_shadow",
      error: error?.message || String(error),
    };
    warnings.push("IBKR Shadow compare failed");
  }

  const comparison = buildWheelShadowComparison(yahoo, ibkr);
  const yahooOk = yahoo?.ok === true;
  const ibkrOk = ibkr?.ok === true;
  let status = "different";
  if (!yahooOk && !ibkrOk) status = "both_failed";
  else if (yahooOk && !ibkrOk) status = "ibkr_unavailable";
  else if (!yahooOk && ibkrOk) status = "yahoo_unavailable";
  else if (comparison.sameAggressiveStrike === true && comparison.sameSafeStrike === true) status = "confirmed";
  else status = "different";

  return {
    symbol,
    ok: Boolean(yahooOk || ibkrOk),
    yahoo,
    ibkr,
    comparison,
    status,
    warnings,
  };
}

function isLocalIbkrRequest(req) {
  if (process.env.RENDER) return false;

  const hostname = String(req.hostname || "").toLowerCase();
  const hostHeader = String(req.headers?.host || "").toLowerCase();
  const ip = String(req.ip || "").toLowerCase();

  const isLocalHostname = hostname === "localhost" || hostname === "127.0.0.1";
  const isLocalHostHeader =
    hostHeader === "localhost:3001" ||
    hostHeader === "127.0.0.1:3001" ||
    hostHeader === "localhost" ||
    hostHeader === "127.0.0.1";
  const isLocalIp = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  const isLocal = isLocalIp || (isLocalHostname && isLocalHostHeader);

  if (process.env.NODE_ENV === "production" && !isLocal) return false;
  return isLocal;
}

function requireLocalIbkrShadow(req, res) {
  if (isLocalIbkrRequest(req)) return true;
  res.status(403).json({
    ok: false,
    provider: "IBKR",
    mode: "ibkr_readonly_shadow",
    error: "ibkr_shadow_local_only",
  });
  return false;
}

app.post("/ibkr/shadow/wheel", async (req, res) => {
  if (!requireLocalIbkrShadow(req, res)) return;
  try {
    const { status, payload } = await runIbkrShadowWheel(req.body ?? {});
    res.status(status).json(payload);
  } catch (error) {
    res.status(500).json({
      ok: false,
      provider: "IBKR",
      mode: "ibkr_readonly_shadow",
      error: error?.message || String(error),
    });
  }
});

app.post("/ibkr/shadow/scan", async (req, res) => {
  if (!requireLocalIbkrShadow(req, res)) return;
  const abortController = new AbortController();
  let requestAborted = false;
  const abortScan = (reason) => {
    if (requestAborted) return;
    requestAborted = true;
    console.warn("[IBKR_SHADOW_SCAN_ABORT]", reason);
    abortController.abort(reason);
  };
  const onReqAborted = () => abortScan("client_aborted");
  const onResClose = () => {
    if (!res.writableEnded) abortScan("response_closed_before_finish");
  };
  req.once("aborted", onReqAborted);
  res.once("close", onResClose);
  try {
    const body = req.body ?? {};
    const rawTickers = Array.isArray(body.tickers) ? body.tickers : [];
    const requestedAuditDepth = toPositiveInt(
      body.auditDepth ?? body.ibkrValidationCount ?? body.maxTickers ?? body.topN,
      20
    );
    const clampedAuditDepth = Math.min(Math.max(requestedAuditDepth, 10), 120);
    const maxTickers = Math.min(Math.max(toPositiveInt(body.maxTickers, clampedAuditDepth), 10), 120);
    const topN = Math.min(Math.max(toPositiveInt(body.topN, clampedAuditDepth), 10), 120);
    const tickers = [
      ...new Set(rawTickers.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean)),
    ].slice(0, maxTickers);
    if (!tickers.length) {
      return res.status(400).json({
        ok: false,
        mode: "ibkr_shadow_scan",
        source: "IBKR",
        readOnly: true,
        error: "missing_tickers",
      });
    }

    const expiration =
      body.expiration == null || String(body.expiration).trim() === ""
        ? ""
        : ymdDashedToCompact(String(body.expiration).trim());
    const clientIdStart = toPositiveInt(body.clientIdStart, 500);
    const devMode = getWheelDevScanMode();
    const devScanEnabled = devMode.devScanEnabled;
    const marketDataType = devMode.marketRegime === "REGULAR" ? 1 : 2;
    const marketDataTypeRequestedLabel = ibkrMarketDataTypeLabel(marketDataType);
    const maxStrikes = toPositiveInt(body.maxStrikes, 25);
    const sort = String(body.sort || "quality").trim().toLowerCase();
    const batchTimeoutMs = Math.min(300_000, 30_000 + tickers.length * 12_000);
    const startedAt = Date.now();
    const ibkrDebug = process.env.WHEEL_IBKR_DEBUG === "1";
    const twoPhaseScanEnabled = resolveIbkrTwoPhaseScanEnabled();

    // Batching IBKR : chaque requête = 1 spawn Python. Le dashboard chunke déjà
    // par IBKR_SCAN_BATCH_SIZE, donc ibkrActualSent <= configuredBatchSize en UI.
    const ibkrConfiguredBatchSize = resolveIbkrScanBatchSize();
    const ibkrActualSent = tickers.length;
    const ibkrBatchSize = Math.min(ibkrActualSent, ibkrConfiguredBatchSize) || ibkrActualSent;
    const ibkrBatchCount = ibkrBatchSize > 0 ? Math.ceil(ibkrActualSent / ibkrBatchSize) : 1;
    const ibkrBatchingMode = process.env.IBKR_SCAN_BATCH_SIZE ? "env" : "default";

    console.log(
      "[WHEEL_DEV_SCAN]",
      `${devMode.configuredMode}`,
      devScanEnabled ? "dev_on" : "dev_off",
      `regime=${devMode.marketRegime}`,
      devMode.reason
    );

    console.log("[IBKR_SHADOW_SCAN_START]", expiration || "default", "tickers", tickers.length);
    console.log(
      "[IBKR BATCHING] totalTickers=" + ibkrActualSent +
        " batchSize=" + ibkrBatchSize +
        " batchCount=" + ibkrBatchCount +
        " requestedDepth=" + clampedAuditDepth +
        " configuredBatchSize=" + ibkrConfiguredBatchSize +
        " mode=" + ibkrBatchingMode
    );
    console.log("[IBKR BATCHING] batchIndex=0 symbols=" + tickers.join(","));
    const twoPhaseScanLog = formatIbkrTwoPhaseScanLog();
    for (const line of twoPhaseScanLog.logLines) {
      console.log(line);
    }
    console.log(formatIbkrProgressiveSafeScanLog().logLine);
    console.log(formatIbkrQuickPremiumGateLog().logLine);

    const { payload } = await runIbkrShadowWheelBatch({
      ...body,
      tickers,
      ibkrExpiration: expiration,
      clientIdStart,
      marketDataType,
      maxStrikes,
      perTickerTimeoutMs: body.perTickerTimeoutMs,
      batchTimeoutMs,
      abortSignal: abortController.signal,
      onAbort: () => console.warn("[IBKR_SHADOW_SCAN_CHILD_ABORT_REQUESTED]", tickers.length),
    });
    if (requestAborted || abortController.signal.aborted || res.destroyed) {
      return;
    }
    const rows = Array.isArray(payload?.results) ? payload.results : [];
    const scanCompletedAt =
      typeof payload?.scanCompletedAt === "string" && payload.scanCompletedAt
        ? payload.scanCompletedAt
        : new Date().toISOString();
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      if (row.marketDataTypeRequested == null) row.marketDataTypeRequested = marketDataType;
      if (row.marketDataTypeRequestedLabel == null)
        row.marketDataTypeRequestedLabel = marketDataTypeRequestedLabel;
      if (row.marketDataTypeReceivedLabel == null && row.marketDataTypeReceived == null) {
        row.marketDataTypeReceivedLabel = "unknown";
      } else if (row.marketDataTypeReceivedLabel == null) {
        row.marketDataTypeReceivedLabel = ibkrMarketDataTypeLabel(row.marketDataTypeReceived);
      }
      if (row.scanCompletedAt == null) row.scanCompletedAt = scanCompletedAt;
    }
    const responseTwoPhaseEnabled =
      typeof payload?.twoPhaseEnabled === "boolean" ? payload.twoPhaseEnabled : twoPhaseScanEnabled;
    const rejectionReasons = buildIbkrRejectionReasons(rows);
    const enrichedIbkrCallMetrics = enrichIbkrCallMetrics(
      payload?.ibkrCallMetrics,
      rows,
      rejectionReasons
    );
    enrichedIbkrCallMetrics.twoPhaseEnabled = responseTwoPhaseEnabled;
    enrichedIbkrCallMetrics.quickPremiumGateEnabled =
      typeof payload?.quickPremiumGateEnabled === "boolean"
        ? payload.quickPremiumGateEnabled
        : typeof enrichedIbkrCallMetrics.quickPremiumGateEnabled === "boolean"
          ? enrichedIbkrCallMetrics.quickPremiumGateEnabled
          : false;
    if (!enrichedIbkrCallMetrics.totals || typeof enrichedIbkrCallMetrics.totals !== "object") {
      enrichedIbkrCallMetrics.totals = {};
    }
    if (!Number.isFinite(Number(enrichedIbkrCallMetrics.totals.totalExpectedMoveContractsRequested))) {
      enrichedIbkrCallMetrics.totals.totalExpectedMoveContractsRequested = 0;
    }
    if (!Number.isFinite(Number(enrichedIbkrCallMetrics.totals.totalPutCandidateContractsRequested))) {
      enrichedIbkrCallMetrics.totals.totalPutCandidateContractsRequested = 0;
    }
    if (!Number.isFinite(Number(enrichedIbkrCallMetrics.totals.totalApproxCalls))) {
      enrichedIbkrCallMetrics.totals.totalApproxCalls = toNumber(
        enrichedIbkrCallMetrics.totals.totalApproxIbkrCalls,
        0
      );
    }
    mergeIbkrCallMetricsIntoState(enrichedIbkrCallMetrics);
    scanMetricsState.lastRefreshAt = new Date().toISOString();
    const shortlist = [];
    const shortlistDev = [];
    const rejected = [];
    const errors = [];

    for (const row of rows) {
      const reason = getIbkrScanReason(row);
      const status = getIbkrTickerStatus(row);
      const rowMetrics = buildIbkrTickerMetricRow(row);
      if (ibkrDebug) {
        const tag = status === "timeout" ? "[IBKR_TICKER_TIMEOUT]" : "[IBKR_TICKER_DONE]";
        console.log(
          tag,
          row?.symbol || "UNKNOWN",
          rowMetrics.durationMs ?? "duration_unknown",
          status,
          rowMetrics.approxCalls ?? 0
        );
      }
      if (reason) {
        rejected.push({
          symbol: row?.symbol ?? null,
          status,
          reason,
          durationMs: row?.durationMs ?? null,
          ibkrCallMetrics: rowMetrics,
          safeStrike: row?.safeStrike ?? null,
          aggressiveStrike: row?.aggressiveStrike ?? null,
          targetPremium: row?.targetPremium ?? null,
          error: row?.error ?? null,
          // Diagnostic timeout (observabilité) : étape exacte si le sous-processus
          // a été tué par le hard timeout. null pour les rejets non-timeout.
          timeoutStage: row?.timeoutStage ?? null,
          ...buildIbkrShadowRejectedForensics(row, reason),
        });
        if (row?.ok !== true) errors.push({ symbol: row?.symbol ?? null, error: reason });
        if (devScanEnabled && row?.ibkrDevDisplay === true) {
          shortlistDev.push(toIbkrScanDevCandidate(row, devScanEnabled));
        }
        continue;
      }
      shortlist.push(toIbkrScanCandidate(row, devScanEnabled));
    }

    shortlist.sort((a, b) => compareIbkrScanCandidates(a, b, sort));
    shortlistDev.sort((a, b) => compareIbkrScanCandidates(a, b, sort));
    shortlist.forEach((item, idx) => {
      item.ibkrRank = idx + 1;
    });
    shortlistDev.forEach((item, idx) => {
      item.ibkrRank = idx + 1;
    });
    const responseWarnings =
      payload?.ok === false ? [payload?.error || "IBKR Shadow scan failed"] : [];
    if (devScanEnabled && !responseWarnings.includes(WHEEL_DEV_SCAN_WARNING)) {
      responseWarnings.push(WHEEL_DEV_SCAN_WARNING);
    }
    const suspiciousIbkrEmpty =
      tickers.length > 0 &&
      rows.length === 0 &&
      rejected.length === 0 &&
      errors.length === 0 &&
      payload?.ok !== false;
    if (suspiciousIbkrEmpty) {
      responseWarnings.push(
        "IBKR / TWS : aucun résultat par symbole (stdout Python vide ou connexion impossible). Ouvre TWS / IB Gateway puis relance."
      );
    }

    console.log(
      "[IBKR_SHADOW_SCAN_DONE]",
      "scanned",
      tickers.length,
      "kept",
      shortlist.length,
      devScanEnabled ? "devDisplayed" : "dev_off",
      devScanEnabled ? shortlistDev.length : 0,
      "rejected",
      rejected.length,
      "errors",
      errors.length,
      "durationMs",
      Date.now() - startedAt,
      "approxCalls",
      enrichedIbkrCallMetrics?.totals?.totalApproxIbkrCalls ?? 0
    );
    const serverDurationMs = Date.now() - startedAt;
    const ibkrDurationMs = numberOrNull(payload?.durationMs);
    const ibkrPerfSummary = buildIbkrPerformanceSummary(
      rows,
      ibkrDurationMs,
      serverDurationMs,
      10
    );
    const _totals = enrichedIbkrCallMetrics?.totals ?? {};
    const _qualifyCalls =
      (Number(_totals.totalOptionQualifyCalls) || 0) +
      (Number(_totals.totalStockQualifyCalls) || 0);
    const scanTiming = {
      totalSeconds: +(serverDurationMs / 1000).toFixed(1),
      ibkrSeconds: ibkrDurationMs != null ? +(ibkrDurationMs / 1000).toFixed(1) : null,
      avgIbkrPerTicker: ibkrPerfSummary?.avgDurationMs != null
        ? +(ibkrPerfSummary.avgDurationMs / 1000).toFixed(1)
        : null,
      ibkrMode: responseTwoPhaseEnabled ? "TWO_PHASE" : "NORMAL",
      concurrency: numberOrNull(payload?.concurrency) ?? resolveIbkrScanConcurrency(),
      concurrencyMode: typeof payload?.concurrencyMode === "string" ? payload.concurrencyMode : null,
      maxActiveTasks: numberOrNull(payload?.maxActiveTasks),
      tickerCount: tickers.length,
      keptCount: shortlist.length,
      rejectedCount: rejected.length,
      timeoutCount: ibkrPerfSummary?.timeoutCount ?? 0,
      ibkrTotalCalls: Number(_totals.totalApproxIbkrCalls) || null,
      ibkrOptionMarketDataRequests: Number(_totals.totalOptionMarketDataRequests) || null,
      ibkrQualifyCalls: _qualifyCalls || null,
      ibkrBatchSize,
      ibkrBatchCount,
      ibkrBatchingMode,
      ibkrRequestedDepth: clampedAuditDepth,
      ibkrActualSent,
    };

    // Phase 1 — ticker_scan_memory : enregistre les résultats APRÈS coup.
    // Read-only vis-à-vis du scan : n'altère ni la sélection, ni le ranking, ni le scoring.
    // Garde-fous (suspiciousEmpty, batch entièrement en erreur) gérés dans le store.
    try {
      const yahooRankBySymbol = new Map();
      tickers.forEach((sym, idx) => {
        yahooRankBySymbol.set(String(sym).trim().toUpperCase(), idx + 1);
      });
      const memoryEntries = [];
      for (const cand of shortlist) {
        const sym = String(cand?.symbol || "").trim().toUpperCase();
        if (!sym) continue;
        memoryEntries.push({
          symbol: sym,
          status: "kept",
          reason: "OK",
          spreadPct: numberOrNull(cand?.spreadPct),
          premiumYield: numberOrNull(cand?.weeklyYield),
          yahooRank: yahooRankBySymbol.get(sym) ?? null,
        });
      }
      for (const rej of rejected) {
        const sym = String(rej?.symbol || "").trim().toUpperCase();
        if (!sym) continue;
        // Forensics du rejet (best-effort) : spread/yield du meilleur put safe near-miss
        // ou du strike agressif. Souvent null pour les no_data / timeout, ce qui est attendu.
        const spreadPct = numberOrNull(rej?.bestSafeSpreadPct ?? rej?.aggressiveSpreadPct);
        const yieldPct = numberOrNull(rej?.bestSafeYieldPct ?? rej?.aggressiveYieldPct);
        memoryEntries.push({
          symbol: sym,
          status: rej?.status ?? "rejected",
          reason: rej?.reason ?? null,
          spreadPct,
          premiumYield: yieldPct != null ? yieldPct / 100 : null,
          yahooRank: yahooRankBySymbol.get(sym) ?? null,
        });
      }
      const memoryResult = await tickerScanMemoryStore.recordScan({
        entries: memoryEntries,
        suspiciousEmpty: suspiciousIbkrEmpty,
        scanTimestamp: scanCompletedAt,
      });
      if (memoryResult?.skipped) {
        console.log("[TICKER_SCAN_MEMORY]", "skipped", memoryResult.reason, "entries", memoryEntries.length);
      } else {
        console.log("[TICKER_SCAN_MEMORY]", "updated", memoryResult?.updated ?? 0, "tickers");
      }
    } catch (memoryError) {
      // Mémoire best-effort : ne jamais faire échouer le scan.
      console.warn("[TICKER_SCAN_MEMORY]", "record error", memoryError?.message || String(memoryError));
    }

    res.json({
      ok: true,
      mode: "ibkr_shadow_scan",
      source: "IBKR",
      readOnly: true,
      marketDataTypeRequested: marketDataType,
      marketDataTypeRequestedLabel,
      scanCompletedAt,
      twoPhaseEnabled: responseTwoPhaseEnabled,
      // Echo config progressive SAFE (observabilité seulement) — relayé tel quel du batch
      // Python vers le forensic JSON exporté. Aucune incidence sur sélection/scoring.
      progressiveSafeScanEnabled:
        typeof payload?.progressiveSafeScanEnabled === "boolean"
          ? payload.progressiveSafeScanEnabled
          : resolveIbkrProgressiveSafeScanEnabled(),
      maxValidPutsEffective:
        numberOrNull(payload?.maxValidPutsEffective) ??
        resolveIbkrProgressiveSafeScanMaxValidPuts(),
      configuredDevScanMode: devMode.configuredMode,
      devScanEnabled: devMode.devScanEnabled,
      marketRegime: devMode.marketRegime,
      dataTradable: devMode.dataTradable,
      ...(devScanEnabled
        ? {
            warning: WHEEL_DEV_SCAN_WARNING,
            shortlistDev: shortlistDev.slice(0, topN),
            devDisplayed: shortlistDev.length,
            devDisplayedReturned: Math.min(topN, shortlistDev.length),
          }
        : {}),
      expiration,
      auditDepth: clampedAuditDepth,
      scanned: tickers.length,
      kept: shortlist.length,
      returned: Math.min(topN, shortlist.length),
      durationMs: serverDurationMs,
      ibkrDurationMs,
      batchTimeoutMs,
      shortlist: shortlist.slice(0, topN),
      rejected,
      errors,
      rejectionReasons,
      warnings: responseWarnings,
      ibkrSuspiciousEmpty: suspiciousIbkrEmpty,
      ibkr: {
        twoPhaseEnabled: responseTwoPhaseEnabled,
      },
      scanTiming,
      ibkrPerfSummary,
      ibkrCallMetrics: enrichedIbkrCallMetrics,
    });
  } catch (error) {
    if (requestAborted || abortController.signal.aborted || res.destroyed) {
      return;
    }
    console.error("[IBKR_SHADOW_SCAN_DONE]", "error", error?.message || String(error));
    res.status(500).json({
      ok: false,
      mode: "ibkr_shadow_scan",
      source: "IBKR",
      readOnly: true,
      error: error?.message || String(error),
    });
  } finally {
    req.removeListener("aborted", onReqAborted);
    res.removeListener("close", onResClose);
  }
});

app.post("/shadow/compare/wheel", async (req, res) => {
  if (!requireLocalIbkrShadow(req, res)) return;
  try {
    const body = req.body ?? {};
    const symbol = String(body.symbol || "NVDA").trim().toUpperCase() || "NVDA";
    const expiration = body.expiration == null ? "" : String(body.expiration).trim();
    const ibkrExpiration =
      body.ibkrExpiration == null || String(body.ibkrExpiration).trim() === ""
        ? ymdDashedToCompact(expiration)
        : String(body.ibkrExpiration).trim();
    const result = await compareWheelShadowForSymbol({
      symbol,
      expiration,
      ibkrExpiration,
      clientId: body.clientId,
      marketDataType: body.marketDataType,
      maxStrikes: body.maxStrikes,
      debug: body.debug,
    });

    res.json({
      ok: result.ok,
      mode: "wheel_compare_shadow",
      symbol,
      expiration,
      ibkrExpiration,
      yahoo: result.yahoo,
      ibkr: result.ibkr,
      comparison: result.comparison,
      warnings: result.warnings,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      mode: "wheel_compare_shadow",
      error: error?.message || String(error),
    });
  }
});

app.post("/shadow/compare/wheel/batch", async (req, res) => {
  if (!requireLocalIbkrShadow(req, res)) return;
  try {
    const body = req.body ?? {};
    const rawTickers = Array.isArray(body.tickers) ? body.tickers : [];
    const cleanedTickers = [...new Set(rawTickers.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean))];
    if (!cleanedTickers.length) {
      return res.status(400).json({
        ok: false,
        mode: "wheel_compare_shadow_batch",
        error: "missing_tickers",
      });
    }
    if (cleanedTickers.length > 50) {
      return res.status(400).json({
        ok: false,
        mode: "wheel_compare_shadow_batch",
        error: "too_many_tickers",
      });
    }

    const expiration = body.expiration == null ? "" : String(body.expiration).trim();
    const ibkrExpiration =
      body.ibkrExpiration == null || String(body.ibkrExpiration).trim() === ""
        ? ymdDashedToCompact(expiration)
        : String(body.ibkrExpiration).trim();
    const clientIdStart = toPositiveInt(body.clientIdStart, 300);
    const marketDataType = toPositiveInt(body.marketDataType, 2);
    const maxStrikes = toPositiveInt(body.maxStrikes, 25);
    const delayMs = Math.max(0, toPositiveInt(body.delayMs, 500));

    const batchStartedAt = Date.now();
    const ibkrBatchResult = await runIbkrShadowWheelBatch({
      ...body,
      tickers: cleanedTickers,
      ibkrExpiration,
      clientIdStart,
      marketDataType,
      maxStrikes,
      perTickerTimeoutMs: body.perTickerTimeoutMs,
    });
    const ibkrBatchPayload = ibkrBatchResult.payload ?? {};
    mergeIbkrCallMetricsIntoState(ibkrBatchPayload?.ibkrCallMetrics);
    scanMetricsState.lastRefreshAt = new Date().toISOString();
    const ibkrRows = Array.isArray(ibkrBatchPayload?.results) ? ibkrBatchPayload.results : [];
    const ibkrBySymbol = new Map(
      ibkrRows
        .map((row) => [String(row?.symbol || "").trim().toUpperCase(), row])
        .filter(([symbol]) => Boolean(symbol))
    );

    const results = [];
    const summary = {
      confirmed: 0,
      different: 0,
      ibkr_unavailable: 0,
      yahoo_unavailable: 0,
      both_failed: 0,
    };

    for (let i = 0; i < cleanedTickers.length; i += 1) {
      const symbol = cleanedTickers[i];
      const rowStartedAt = Date.now();
      try {
        const warnings = [];
        let yahoo = null;
        try {
          yahoo = await wheelScanner.scanTicker(symbol, expiration);
          if (!yahoo?.ok) {
            yahoo = { ok: false, symbol, expiration, error: yahoo?.reason || yahoo?.error || "yahoo_compare_failed" };
            warnings.push("Yahoo compare failed");
          }
        } catch (error) {
          yahoo = { ok: false, symbol, expiration, error: error?.message || String(error) };
          warnings.push("Yahoo compare failed");
        }

        const ibkr = ibkrBySymbol.get(symbol) ?? {
          ok: false,
          provider: "IBKR",
          mode: "ibkr_readonly_shadow",
          symbol,
          error: ibkrBatchPayload?.error || "ibkr_unavailable",
          reason: ibkrBatchPayload?.error === "ibkr_shadow_batch_timeout" ? "timeout" : "ibkr_unavailable",
          durationMs: null,
        };
        if (!ibkr?.ok) warnings.push("IBKR Shadow compare failed");

        const comparison = buildWheelShadowComparison(yahoo, ibkr);
        const yahooOk = yahoo?.ok === true;
        const ibkrOk = ibkr?.ok === true;
        let status = "different";
        if (!yahooOk && !ibkrOk) status = "both_failed";
        else if (yahooOk && !ibkrOk) status = "ibkr_unavailable";
        else if (!yahooOk && ibkrOk) status = "yahoo_unavailable";
        else if (comparison.sameAggressiveStrike === true && comparison.sameSafeStrike === true) status = "confirmed";
        else status = "different";

        const row = {
          symbol,
          ok: Boolean(yahooOk || ibkrOk),
          yahoo,
          ibkr,
          comparison,
          status,
          warnings,
          durationMs: numberOrNull(ibkr?.durationMs) ?? Date.now() - rowStartedAt,
        };
        results.push(row);
        if (Object.prototype.hasOwnProperty.call(summary, row.status)) summary[row.status] += 1;
      } catch (error) {
        const fallback = {
          symbol,
          ok: false,
          yahoo: { ok: false, symbol, expiration, error: "yahoo_compare_failed" },
          ibkr: {
            ok: false,
            provider: "IBKR",
            mode: "ibkr_readonly_shadow",
            error: error?.message || String(error),
          },
          comparison: {
            underlyingPriceDiff: null,
            expectedMoveDiff: null,
            lowerBoundDiff: null,
            aggressiveStrikeDiff: null,
            safeStrikeDiff: null,
            sameAggressiveStrike: null,
            sameSafeStrike: null,
          },
          status: "both_failed",
          warnings: ["Yahoo compare failed", "IBKR Shadow compare failed"],
          durationMs: Date.now() - rowStartedAt,
        };
        results.push(fallback);
        summary.both_failed += 1;
      }

      if (i < cleanedTickers.length - 1 && delayMs > 0) {
        await sleepMs(delayMs);
      }
    }

    res.json({
      ok: true,
      mode: "wheel_compare_shadow_batch",
      expiration,
      ibkrExpiration,
      total: cleanedTickers.length,
      completed: results.length,
      durationMs: Date.now() - batchStartedAt,
      ibkrDurationMs: numberOrNull(ibkrBatchPayload?.durationMs),
      results,
      summary,
      warnings: ibkrBatchPayload?.ok === false ? [ibkrBatchPayload?.error || "IBKR Shadow batch failed"] : [],
      ibkrCallMetrics: ibkrBatchPayload?.ibkrCallMetrics ?? null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      mode: "wheel_compare_shadow_batch",
      error: error?.message || String(error),
    });
  }
});

app.get("/tools", (_req, res) => {
  res.json({
    ok: true,
    tools: [
      "get_quote",
      "get_option_expirations",
      "get_expected_move",
      "get_option_chain",
      "get_best_strike",
      "get_technicals",
      "get_support_resistance",
      "analyze_trade_setup",
      "scan_shortlist",
      "build_watchlist",
    ],
  });
});

app.post("/tools/get_quote", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await marketService.getQuote(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_quote failed" });
  }
});

app.post("/tools/get_option_expirations", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await marketService.getOptionExpirations(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_option_expirations failed" });
  }
});

app.post("/tools/get_option_chain", async (req, res) => {
  try {
    const { symbol, expiration } = req.body;
    const result = await marketService.getOptionChain(symbol, expiration);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_option_chain failed" });
  }
});

app.post("/tools/get_expected_move", async (req, res) => {
  try {
    const { symbol, expiration } = req.body;
    const result = await marketService.getExpectedMove(symbol, expiration);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_expected_move failed" });
  }
});

app.post("/tools/get_best_strike", async (req, res) => {
  try {
    const { symbol, expiration, option_type, target_price, percent_otm } = req.body;
    const result = await marketService.getBestStrike(
      symbol,
      expiration,
      option_type ?? "call",
      target_price ?? null,
      percent_otm ?? null
    );
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_best_strike failed" });
  }
});

app.post("/tools/get_technicals", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await marketService.getTechnicals(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_technicals failed" });
  }
});

app.post("/tools/get_support_resistance", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await marketService.getSupportResistance(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_support_resistance failed" });
  }
});

app.post("/tools/analyze_trade_setup", async (req, res) => {
  try {
    const { symbol, expiration, option_type, strike } = req.body;
    const result = await marketService.analyzeTradeSetup(symbol, expiration, option_type ?? "put", strike);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "analyze_trade_setup failed" });
  }
});

app.post("/scan_shortlist", async (req, res) => {
  const yahooStartMs = Date.now();
  try {
    const { expiration, tickers = [], topN = 20, sort = "yield" } = req.body ?? {};
    const { status, payload } = await wheelScanner.scanShortlist({ expiration, tickers, topN, sort });
    const yahooMs = Date.now() - yahooStartMs;
    scanMetricsState.lastRefreshAt = new Date().toISOString();
    let enriched =
      payload && typeof payload === "object"
        ? {
            ...payload,
            scanTiming: {
              yahooSeconds: +(yahooMs / 1000).toFixed(1),
              yahooMs,
              tickerCount: Array.isArray(tickers) ? tickers.length : 0,
            },
          }
        : payload;
    if (enriched && typeof enriched === "object" && enriched.scanFunnelDiagnosticsV1) {
      try {
        const forensic = buildYahooFunnelForensicPayload({
          watchlistDiagnosticsV1: yahooFunnelLastWatchlistDiagnosticsV1,
          scanFunnelDiagnosticsV1: enriched.scanFunnelDiagnosticsV1,
          phase: "watchlist_plus_scan",
          requestBodySnapshot: {
            expiration: req.body?.expiration ?? null,
            topN: req.body?.topN ?? null,
            sort: req.body?.sort ?? null,
            tickerCount: Array.isArray(req.body?.tickers) ? req.body.tickers.length : 0,
          },
        });
        const { path: exportPath } = writeYahooFunnelForensicExport(defaultWheelRepoRoot(), forensic);
        enriched = { ...enriched, yahooFunnelForensicExportPath: exportPath };
      } catch (e) {
        console.warn("[YAHOO_FUNNEL_DIAGNOSTICS] export scan:", e?.message || e);
      }
    }
    if (
      isYahooLiquidityV3SimulationEnabled() &&
      yahooFunnelLastWatchlistDiagnosticsV1 &&
      enriched &&
      typeof enriched === "object"
    ) {
      const v3Path = maybeExportYahooLiquidityV3Simulation(
        yahooFunnelLastWatchlistDiagnosticsV1,
        null,
        { rejectedCandidatesBeforeYahooLiquidityV3LiveSafe: yahooFunnelLastRejectedCandidatesBeforeV3LiveSafe }
      );
      if (v3Path) enriched = { ...enriched, yahooLiquidityV3SimulationPath: v3Path };
    }
    res.status(status).json(enriched);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "scan_shortlist failed" });
  }
});

app.get("/journal/wheel-validation", async (_req, res) => {
  try {
    const journal = await wheelValidationService.listJournal();
    res.json({
      ok: true,
      journal,
      totalRecords: Array.isArray(journal?.records) ? journal.records.length : 0,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_get_failed",
    });
  }
});

app.get("/journal/wheel-validation/stats", async (_req, res) => {
  try {
    const stats = await wheelValidationService.computeStats();
    res.json({
      ok: true,
      stats,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_stats_failed",
    });
  }
});

app.get("/journal/wheel-validation/cohort-summary", async (_req, res) => {
  try {
    const summary = await wheelValidationService.computeCohortSummary();
    res.json({
      ok: true,
      summary,
      totalCohorts: Array.isArray(summary) ? summary.length : 0,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_cohort_summary_failed",
    });
  }
});

app.get("/journal/wheel-validation/calibration-summary", async (_req, res) => {
  try {
    const calibration = await wheelValidationService.computeCalibrationSummary();
    res.json({
      ok: true,
      calibration,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_calibration_summary_failed",
    });
  }
});

app.get("/journal/wheel-validation/real-pop-calibration", async (req, res) => {
  try {
    const asOf = req.query?.asOf ?? req.query?.today ?? undefined;
    const payload = await wheelValidationService.computeRealPopCalibration(
      asOf != null ? { today: asOf } : {}
    );
    res.json({
      ok: true,
      calibration: payload.calibration,
      matrix: payload.matrix,
      pending: payload.pending,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_real_pop_calibration_failed",
    });
  }
});

app.get("/journal/wheel-validation/mode-comparison", async (_req, res) => {
  try {
    const modeComparison = await wheelValidationService.computeModeComparison();
    res.json({ ok: true, modeComparison });
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || "mode_comparison_failed" });
  }
});

app.get("/journal/wheel-validation/premium-stability", async (req, res) => {
  try {
    const premiumStability = await wheelValidationService.computePremiumStability({
      ticker: req.query?.ticker,
      mode: req.query?.mode,
      limit: req.query?.limit,
    });
    res.json({
      ok: true,
      summary: premiumStability.summary,
      groups: premiumStability.groups,
      recommendedWindows: premiumStability.recommendedWindows,
      filters: premiumStability.filters,
      generatedAt: premiumStability.generatedAt,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "premium_stability_failed",
    });
  }
});

app.get("/journal/wheel-validation/theoretical-cycles", async (req, res) => {
  try {
    const payload = readTheoreticalCyclesSnapshot({
      limit: req.query?.limit,
      ticker: req.query?.ticker,
      status: req.query?.status,
      sold: req.query?.sold,
    });
    res.json({
      ok: true,
      summary: payload.summary,
      cycles: payload.cycles,
      assignment_depth_summary: payload.assignment_depth_summary ?? payload.summary?.assignment_depth_summary ?? null,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "theoretical_cycles_fetch_failed",
    });
  }
});

app.get("/journal/wheel-validation/ticker-ranking", async (req, res) => {
  try {
    const { limit, minSample, mode, ticker } = req.query;
    const theoreticalCyclesData = readTheoreticalCyclesSnapshot({ limit: 1000 });
    const theoreticalCycles = Array.isArray(theoreticalCyclesData?.cycles) ? theoreticalCyclesData.cycles : [];
    const result = await wheelValidationService.computeTickerRanking({
      limit: limit != null ? Number(limit) : undefined,
      minSample: minSample != null ? Number(minSample) : undefined,
      mode,
      ticker,
      theoreticalCycles,
    });
    res.json(result);
  } catch (error) {
    console.error("[ticker-ranking]", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "ticker_ranking_failed",
    });
  }
});

app.get("/journal/wheel-validation/normalized-observations", async (req, res) => {
  try {
    const { ticker, mode, limit } = req.query;
    const result = await wheelValidationService.computeNormalizedDailyPopObservations({
      ticker,
      mode,
      limit: limit != null ? Number(limit) : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[normalized-observations]", error);
    res.status(500).json({ ok: false, error: error?.message || "normalized_observations_failed" });
  }
});

app.get("/journal/wheel-validation/safe-aggressive-comparison", async (req, res) => {
  try {
    const { ticker, dte, limit, minSample } = req.query;
    const result = await wheelValidationService.computeSafeAggressiveComparison({
      ticker,
      dte: dte != null ? Number(dte) : undefined,
      limit: limit != null ? Number(limit) : undefined,
      minSample: minSample != null ? Number(minSample) : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[safe-aggressive-comparison]", error);
    res.status(500).json({ ok: false, error: error?.message || "safe_aggressive_comparison_failed" });
  }
});

app.get("/journal/wheel-validation/one-percent-wheel-profiles", async (req, res) => {
  try {
    const asOf = req.query?.asOf ?? req.query?.today ?? undefined;
    const theoreticalCyclesData = readTheoreticalCyclesSnapshot({ limit: 1000 });
    const theoreticalCycles = Array.isArray(theoreticalCyclesData?.cycles) ? theoreticalCyclesData.cycles : [];
    const result = await wheelValidationService.computeOnePercentWheelProfiles({
      today: asOf,
      theoreticalCycles,
      minModeProfileN:
        req.query?.minModeProfileN != null ? Number(req.query.minModeProfileN) : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[one-percent-wheel-profiles]", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "one_percent_wheel_profiles_failed",
    });
  }
});

app.get("/journal/wheel-validation/latest-option-snapshots", async (req, res) => {
  try {
    const result = await wheelValidationService.getLatestOptionSnapshots({
      limit: req.query?.limit != null ? Number(req.query.limit) : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[latest-option-snapshots]", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "latest_option_snapshots_failed",
    });
  }
});

app.get("/journal/wheel-validation/dynamic-top20-wheel", async (req, res) => {
  try {
    const asOf = req.query?.asOf ?? req.query?.today ?? undefined;
    const theoreticalCyclesData = readTheoreticalCyclesSnapshot({ limit: 1000 });
    const theoreticalCycles = Array.isArray(theoreticalCyclesData?.cycles) ? theoreticalCyclesData.cycles : [];
    const result = await wheelValidationService.computeDynamicTop20WheelProfiles({
      today: asOf,
      theoreticalCycles,
      minModeProfileN:
        req.query?.minModeProfileN != null ? Number(req.query.minModeProfileN) : undefined,
    });
    res.json(result);
  } catch (error) {
    console.error("[dynamic-top20-wheel]", error);
    res.status(500).json({
      ok: false,
      error: error?.message || "dynamic_top20_wheel_failed",
    });
  }
});

app.get("/journal/wheel-validation/v3-candidate-profiles", async (req, res) => {
  try {
    const { limit, ticker, mode, minExpirations, includeWeak, scope } = req.query;
    const result = await wheelValidationService.computeV3CandidateProfiles({
      limit: limit != null ? Number(limit) : undefined,
      ticker,
      mode,
      scope,
      minExpirations: minExpirations != null ? Number(minExpirations) : undefined,
      includeWeak,
    });
    res.json(result);
  } catch (error) {
    console.error("[v3-candidate-profiles]", error);
    res.status(500).json({ ok: false, error: error?.message || "v3_candidate_profiles_failed" });
  }
});

app.post("/journal/wheel-validation/capture", async (req, res) => {
  try {
    const body = req.body ?? {};
    const candidates = Array.isArray(body.candidates)
      ? body.candidates
      : Array.isArray(body.finalCandidates)
      ? body.finalCandidates
      : Array.isArray(body.items)
      ? body.items
      : [];
    const topN = Math.min(Math.max(toPositiveInt(body.topN, 30), 1), 200);
    console.log("[JOURNAL_CAPTURE_REQUEST]", {
      topN,
      candidatesType: Array.isArray(body.candidates) ? "array" : typeof body.candidates,
      candidatesCount: Array.isArray(candidates) ? candidates.length : 0,
      firstCandidateKeys: Object.keys(candidates?.[0] || {}),
      scanSessionId: body.scanSessionId ?? null,
      captureSource: body.captureSource ?? null,
      selectedExpiration: body.selectedExpiration ?? null,
    });
    const result = await wheelValidationService.captureFromCandidates(candidates, {
      topN,
      scanTimestamp: body.scanTimestamp,
      scanSessionId: body.scanSessionId,
      selectedExpiration: body.selectedExpiration,
      captureSource: body.captureSource,
      dteAtScan: body.dteAtScan,
    });
    console.log("[JOURNAL_CAPTURE_RESULT]", {
      inserted: result?.captured ?? null,
      skipped: result?.skipped ?? null,
      duplicates: result?.duplicates ?? null,
      total: result?.records?.length ?? null,
      skippedReasons: result?.skippedReasons ?? null,
      sampleSkipped: result?.sampleSkipped?.slice?.(0, 3) ?? null,
      errors: result?.errors?.slice?.(0, 3) ?? null,
    });
    res.json({
      ok: true,
      source: "final_candidates_snapshot",
      ...result,
    });
  } catch (error) {
    console.error("[JOURNAL_CAPTURE_ERROR]", {
      message: error?.message,
      stack: error?.stack?.split("\n").slice(0, 5).join("\n"),
    });
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_capture_failed",
    });
  }
});

app.patch("/journal/wheel-validation/:id/resolution", async (req, res) => {
  try {
    const record = await wheelValidationService.patchResolution(req.params.id, req.body ?? {});
    res.json({
      ok: true,
      record,
    });
  } catch (error) {
    if (error?.code === "NOT_FOUND") {
      return res.status(404).json({
        ok: false,
        error: error.message,
      });
    }
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_patch_failed",
    });
  }
});

app.post("/journal/wheel-validation/resolve-expired", async (_req, res) => {
  try {
    const result = await wheelValidationService.resolveExpiredRecords();
    res.json({
      ok: true,
      ...result,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "wheel_validation_resolve_expired_failed",
    });
  }
});

async function handleBuildWatchlist(req, res) {
  try {
    const parsed = buildWatchlistBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: "invalid request body",
        details: parsed.error.flatten(),
      });
    }
    const payload = await watchlistBuilder.buildWatchlist(parsed.data);
    if (payload.watchlistDiagnosticsV1) {
      yahooFunnelLastWatchlistDiagnosticsV1 = payload.watchlistDiagnosticsV1;
      yahooFunnelLastRejectedCandidatesBeforeV3LiveSafe = Array.isArray(
        payload.rejectedCandidatesBeforeYahooLiquidityV3LiveSafe
      )
        ? payload.rejectedCandidatesBeforeYahooLiquidityV3LiveSafe
        : null;
      if (isYahooFunnelDiagnosticsV1Enabled()) {
        try {
          const forensic = buildYahooFunnelForensicPayload({
            watchlistDiagnosticsV1: payload.watchlistDiagnosticsV1,
            scanFunnelDiagnosticsV1: null,
            phase: "watchlist_only",
          });
          const { path: exportPath } = writeYahooFunnelForensicExport(defaultWheelRepoRoot(), forensic);
          payload.yahooFunnelForensicExportPath = exportPath;
        } catch (e) {
          console.warn("[YAHOO_FUNNEL_DIAGNOSTICS] export watchlist:", e?.message || e);
        }
      }
      const v3Path = maybeExportYahooLiquidityV3Simulation(payload.watchlistDiagnosticsV1, payload.stats, payload);
      if (v3Path) payload.yahooLiquidityV3SimulationPath = v3Path;
    }
    res.json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "build_watchlist failed" });
  }
}

app.post("/build_watchlist", handleBuildWatchlist);
/** Alias sans le segment "watchlist" dans le chemin (évite certains bloqueurs / filtres d'URL côté navigateur). */
app.post("/universe/build", handleBuildWatchlist);

function handleBuildResearchExpandedPool(req, res) {
  try {
    const parsed = buildResearchExpandedBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        ok: false,
        error: "invalid request body",
        details: parsed.error.flatten(),
      });
    }
    const payload = buildResearchExpandedPool(parsed.data);
    res.json(payload);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message || "universe/research failed",
    });
  }
}

app.post("/universe/research", handleBuildResearchExpandedPool);

// Seasonality Engine V1 — read-only, isolated, additive
app.use("/seasonality", seasonalityRoutes);

// Adaptive Calibration Engine — Phase 4B-PREP — read-only, dormant
// appliedToScanner=false / appliedToRanking=false / appliedToEliteScore=false
app.use("/calibration", createAdaptiveCalibrationRoutes({ store: wheelValidationStore }));

// Scan Funnel Archive — Phase 1 — read-only forensic, même SQLite que Journal POP.
// N'altère NI la sélection, NI le scoring, NI Journal POP capture.
app.use("/scan-funnel", createScanFunnelArchiveRoutes({ store: scanFunnelArchiveStore }));

// Capital Combination Audit — Phase 4D — passive, no scanner hook
// appliedToScanner=false / appliedToRanking=false / appliedToEliteScore=false
app.use("/capital-combinations", createCapitalCombinationRoutes());

app.get("/mcp-info", (_req, res) => {
  res.json({
    ok: true,
    service: "wheel-mcp-backend",
    protocol: "streamable-http",
    endpoint: "/mcp",
    tools: buildToolList().map((t) => t.name),
    activeSessions: mcpSessions.size,
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];
    let transport = null;

    if (sessionId && typeof sessionId === "string" && mcpSessions.has(sessionId)) {
      transport = mcpSessions.get(sessionId).transport;
    } else if (!sessionId && isInitializeRequest(req.body)) {
      let server = null;
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (!mcpSessions.has(newSessionId)) mcpSessions.set(newSessionId, { transport, server });
        },
      });

      transport.onclose = async () => {
        try {
          if (transport?.sessionId && mcpSessions.has(transport.sessionId)) {
            const existing = mcpSessions.get(transport.sessionId);
            mcpSessions.delete(transport.sessionId);
            await existing?.server?.close?.();
          }
        } catch (_error) {}
      };

      server = createMcpServer();
      await server.connect(transport);
    } else {
      return res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Bad Request: missing or invalid MCP session" },
        id: req.body?.id ?? null,
      });
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: error.message || "mcp post failed" },
        id: req.body?.id ?? null,
      });
    }
  }
});

async function handleMcpSessionRequest(req, res) {
  try {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || typeof sessionId !== "string" || !mcpSessions.has(sessionId)) {
      return res.status(400).send("Invalid or missing MCP session ID");
    }
    const { transport } = mcpSessions.get(sessionId);
    await transport.handleRequest(req, res);
  } catch (error) {
    if (!res.headersSent) return res.status(500).send(error.message || "mcp session request failed");
  }
}

app.get("/mcp", handleMcpSessionRequest);
app.delete("/mcp", handleMcpSessionRequest);

app.listen(PORT, () => {
  console.log(`Wheel backend listening on port ${PORT}`);
  logIbkrScanConcurrencyConfig();
  logIbkrScanBatchSizeConfig();
  logIbkrTwoPhaseScanConfig();
  logIbkrProgressiveSafeScanConfig();
  logIbkrQuickPremiumGateConfig();
});


