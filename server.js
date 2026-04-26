import express from "express";
import cors from "cors";
import { randomUUID } from "node:crypto";
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

const app = express();
const PORT = process.env.PORT || DEFAULT_BACKEND_PORT;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const provider = createMarketDataProvider();
const marketService = createMarketService(provider);
const wheelScanner = createWheelScanner(marketService);
const watchlistCache = createWatchlistCache();
const watchlistBuilder = createWatchlistBuilder({ marketService, cache: watchlistCache });

const buildWatchlistBodySchema = z.object({
  maxPrice: z.union([z.literal(100), z.literal(125), z.literal(150), z.literal(200)]),
  minVolume: z.number().positive(),
  requireLiquidOptions: z.boolean(),
  requireWeeklyOptions: z.boolean(),
  categories: z.array(z.enum(["core", "growth", "high_premium", "etf"])).min(1),
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
  res.json({ ok: true, service: "wheel-mcp-backend" });
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
    res.status(status).json(payload);
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "scan_shortlist failed" });
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
/** Alias sans le segment "watchlist" dans le chemin (évite certains bloqueurs / filtres d’URL côté navigateur). */
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
