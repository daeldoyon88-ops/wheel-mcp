import express from "express";
import cors from "cors";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { DEFAULT_BACKEND_PORT } from "./app/config/constants.js";
import { createMarketDataProvider } from "./app/data_providers/createMarketDataProvider.js";
import { createMarketService } from "./app/services/marketService.js";
import { createWheelScanner } from "./app/scanners/wheelScanner.js";
import { createWatchlistCache } from "./app/watchlist/watchlistCache.js";
import { createWatchlistBuilder } from "./app/watchlist/watchlistBuilder.js";
import { getIbkrHealthStatus } from "./app/ibkr/ibkrHealthStatus.js";
import { createWheelValidationService } from "./app/journal/wheelValidationService.js";
import { createWheelValidationStore } from "./app/journal/wheelValidationStore.js";

const app = express();
const PORT = process.env.PORT || DEFAULT_BACKEND_PORT;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

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
  getHistoricalClose: (symbol, dateYmd) => marketService.getHistoricalClose(symbol, dateYmd),
});
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
  maxPrice: z.union([z.literal(100), z.literal(125), z.literal(150), z.literal(200)]),
  minPrice: z.number().min(0).max(1000).optional().default(10),
  minVolume: z.number().positive(),
  maxContractCapital: z.number().positive().optional(),
  minMarketCapB: z.number().min(0).max(1_000_000).optional(),
  requireLiquidOptions: z.boolean(),
  requireWeeklyOptions: z.boolean(),
  categories: z.array(z.enum(["core", "growth", "high_premium", "etf", "weekly"])).min(1),
  limit: z.number().int().positive().max(2000).optional(),
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

app.post("/metrics/scan/reset", (_req, res) => {
  resetScanMetricsState();
  res.json({
    ok: true,
    resetAt: new Date().toISOString(),
    metrics: getScanMetricsSnapshot(),
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
  const twoPhaseScanEnabled = process.env.IBKR_TWO_PHASE_SCAN === "0" ? false : true;

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
    WHEEL_DEV_SCAN: getWheelDevScanMode().devScanEnabled ? "1" : "0",
  };
  const timeoutMs = requestedTimeoutMs > 0
    ? requestedTimeoutMs
    : Math.max(IBKR_SHADOW_TIMEOUT_MS, perTickerTimeoutMs * Math.max(tickers.length, 1) + 20_000);

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
  const n = numberOrNull(strike?.premiumYieldOnUnderlying ?? strike?.premiumYield);
  return n == null ? null : n;
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

function toIbkrScanCandidate(row, devScanEnabled = false) {
  const safe = row?.safeStrike ?? null;
  const aggressive = row?.aggressiveStrike ?? null;
  const primary = safe ?? aggressive;
  const weeklyYield = getIbkrStrikeYield(primary);
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
    annualizedYield: weeklyYield == null ? null : weeklyYield * 52,
    putCandidates: Array.isArray(row.putCandidates) ? row.putCandidates : [],
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
    const marketDataType = toPositiveInt(body.marketDataType, 2);
    const maxStrikes = toPositiveInt(body.maxStrikes, 25);
    const sort = String(body.sort || "quality").trim().toLowerCase();
    const batchTimeoutMs = Math.min(300_000, 30_000 + tickers.length * 12_000);
    const startedAt = Date.now();
    const ibkrDebug = process.env.WHEEL_IBKR_DEBUG === "1";
    const twoPhaseScanEnabled = process.env.IBKR_TWO_PHASE_SCAN === "0" ? false : true;
    const devMode = getWheelDevScanMode();
    const devScanEnabled = devMode.devScanEnabled;

    console.log(
      "[WHEEL_DEV_SCAN]",
      `${devMode.configuredMode}`,
      devScanEnabled ? "dev_on" : "dev_off",
      `regime=${devMode.marketRegime}`,
      devMode.reason
    );

    console.log("[IBKR_SHADOW_SCAN_START]", expiration || "default", "tickers", tickers.length);
    console.log("[IBKR_TWO_PHASE_SCAN]", `enabled=${twoPhaseScanEnabled}`);

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
    const responseTwoPhaseEnabled =
      typeof payload?.twoPhaseEnabled === "boolean" ? payload.twoPhaseEnabled : twoPhaseScanEnabled;
    const rejectionReasons = buildIbkrRejectionReasons(rows);
    const enrichedIbkrCallMetrics = enrichIbkrCallMetrics(
      payload?.ibkrCallMetrics,
      rows,
      rejectionReasons
    );
    enrichedIbkrCallMetrics.twoPhaseEnabled = responseTwoPhaseEnabled;
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

    res.json({
      ok: true,
      mode: "ibkr_shadow_scan",
      source: "IBKR",
      readOnly: true,
      twoPhaseEnabled: responseTwoPhaseEnabled,
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
      durationMs: Date.now() - startedAt,
      ibkrDurationMs: numberOrNull(payload?.durationMs),
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
  try {
    const { expiration, tickers = [], topN = 20, sort = "yield" } = req.body ?? {};
    const { status, payload } = await wheelScanner.scanShortlist({ expiration, tickers, topN, sort });
    scanMetricsState.lastRefreshAt = new Date().toISOString();
    res.status(status).json(payload);
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
    const result = await wheelValidationService.captureFromCandidates(candidates, {
      topN,
      scanTimestamp: body.scanTimestamp,
      scanSessionId: body.scanSessionId,
      selectedExpiration: body.selectedExpiration,
      captureSource: body.captureSource,
      dteAtScan: body.dteAtScan,
    });
    res.json({
      ok: true,
      source: "final_candidates_snapshot",
      ...result,
    });
  } catch (error) {
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
    res.json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "build_watchlist failed" });
  }
}

app.post("/build_watchlist", handleBuildWatchlist);
/** Alias sans le segment "watchlist" dans le chemin (évite certains bloqueurs / filtres d'URL côté navigateur). */
app.post("/universe/build", handleBuildWatchlist);

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
});


