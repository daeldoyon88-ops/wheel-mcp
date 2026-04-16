import express from "express";
import YahooFinance from "yahoo-finance2";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();
const PORT = process.env.PORT || 3000;
const yahooFinance = new YahooFinance();

app.use(express.json({ limit: "1mb" }));

/* ----------------------------- helpers ----------------------------- */

function badRequest(message, details = null) {
  const err = new Error(message);
  err.status = 400;
  err.details = details;
  return err;
}

function parseSymbol(symbol) {
  if (!symbol || typeof symbol !== "string") {
    throw badRequest("Parameter 'symbol' is required and must be a string.");
  }
  return symbol.trim().toUpperCase();
}

function parseExpirationInput(expiration) {
  if (!expiration) return null;

  if (expiration instanceof Date && !Number.isNaN(expiration.getTime())) {
    return expiration;
  }

  if (typeof expiration === "number") {
    const ms = expiration < 1e12 ? expiration * 1000 : expiration;
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) {
      throw badRequest("Invalid numeric expiration date.");
    }
    return d;
  }

  if (typeof expiration === "string") {
    const trimmed = expiration.trim();

    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(`${trimmed}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime())) {
        throw badRequest("Invalid expiration date string.");
      }
      return d;
    }

    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      const ms = n < 1e12 ? n * 1000 : n;
      const d = new Date(ms);
      if (Number.isNaN(d.getTime())) {
        throw badRequest("Invalid expiration timestamp string.");
      }
      return d;
    }

    const d = new Date(trimmed);
    if (!Number.isNaN(d.getTime())) {
      return d;
    }
  }

  throw badRequest(
    "Invalid 'expiration'. Use YYYY-MM-DD, a unix timestamp, or an ISO date string."
  );
}

function toISODate(dateLike) {
  if (!dateLike) return null;
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function round(value, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return null;
  }
  return Number(Number(value).toFixed(digits));
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeMid(bid, ask, lastPrice) {
  const b = toNumber(bid);
  const a = toNumber(ask);
  const l = toNumber(lastPrice);

  if (b !== null && a !== null && b > 0 && a > 0) {
    return (b + a) / 2;
  }
  if (l !== null && l > 0) {
    return l;
  }
  if (b !== null && b > 0) return b;
  if (a !== null && a > 0) return a;
  return null;
}

function parseOptionContract(contract) {
  return {
    contractSymbol: contract?.contractSymbol ?? null,
    strike: toNumber(contract?.strike),
    lastPrice: toNumber(contract?.lastPrice),
    bid: toNumber(contract?.bid),
    ask: toNumber(contract?.ask),
    mid: round(safeMid(contract?.bid, contract?.ask, contract?.lastPrice), 4),
    change: toNumber(contract?.change),
    percentChange: toNumber(contract?.percentChange),
    volume: toNumber(contract?.volume),
    openInterest: toNumber(contract?.openInterest),
    impliedVolatility: toNumber(contract?.impliedVolatility),
    inTheMoney: Boolean(contract?.inTheMoney),
    contractSize: contract?.contractSize ?? null,
    currency: contract?.currency ?? null,
    lastTradeDate: contract?.lastTradeDate
      ? new Date(contract.lastTradeDate).toISOString()
      : null,
    expiration: contract?.expiration
      ? new Date(contract.expiration).toISOString()
      : null,
  };
}

function getCurrentPrice(quote) {
  return (
    toNumber(quote?.regularMarketPrice) ??
    toNumber(quote?.postMarketPrice) ??
    toNumber(quote?.preMarketPrice) ??
    toNumber(quote?.bid) ??
    toNumber(quote?.ask)
  );
}

function daysToExpiration(expirationDate) {
  if (!expirationDate) return null;
  const now = new Date();
  const exp = new Date(expirationDate);
  const ms = exp.getTime() - now.getTime();
  return Math.max(ms / (1000 * 60 * 60 * 24), 0);
}

function pickClosestStrike(contracts, referenceStrike, optionType) {
  const sorted = [...contracts]
    .filter((c) => typeof c.strike === "number")
    .sort((a, b) => {
      const da = Math.abs(a.strike - referenceStrike);
      const db = Math.abs(b.strike - referenceStrike);

      if (da !== db) return da - db;

      if (optionType === "call") {
        const aPref = a.strike >= referenceStrike ? 0 : 1;
        const bPref = b.strike >= referenceStrike ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
      } else {
        const aPref = a.strike <= referenceStrike ? 0 : 1;
        const bPref = b.strike <= referenceStrike ? 0 : 1;
        if (aPref !== bPref) return aPref - bPref;
      }

      return a.strike - b.strike;
    });

  return sorted[0] || null;
}

async function fetchOptions(symbol, expiration = null) {
  const parsedSymbol = parseSymbol(symbol);
  const date = parseExpirationInput(expiration);

  if (date) {
    return yahooFinance.options(parsedSymbol, { date });
  }

  return yahooFinance.options(parsedSymbol);
}

/* ------------------------------ tools ------------------------------ */

async function getQuoteTool({ symbol }) {
  const parsedSymbol = parseSymbol(symbol);
  const quote = await yahooFinance.quote(parsedSymbol);

  return {
    symbol: quote.symbol ?? parsedSymbol,
    shortName: quote.shortName ?? null,
    longName: quote.longName ?? null,
    currency: quote.currency ?? null,
    exchange: quote.fullExchangeName ?? quote.exchange ?? null,
    marketState: quote.marketState ?? null,
    regularMarketPrice: toNumber(quote.regularMarketPrice),
    regularMarketChange: toNumber(quote.regularMarketChange),
    regularMarketChangePercent: toNumber(quote.regularMarketChangePercent),
    regularMarketOpen: toNumber(quote.regularMarketOpen),
    regularMarketDayHigh: toNumber(quote.regularMarketDayHigh),
    regularMarketDayLow: toNumber(quote.regularMarketDayLow),
    regularMarketPreviousClose: toNumber(quote.regularMarketPreviousClose),
    regularMarketVolume: toNumber(quote.regularMarketVolume),
    marketCap: toNumber(quote.marketCap),
    bid: toNumber(quote.bid),
    ask: toNumber(quote.ask),
    fiftyTwoWeekHigh: toNumber(quote.fiftyTwoWeekHigh),
    fiftyTwoWeekLow: toNumber(quote.fiftyTwoWeekLow),
  };
}

async function getOptionExpirationsTool({ symbol }) {
  const parsedSymbol = parseSymbol(symbol);
  const optionsData = await fetchOptions(parsedSymbol);

  return {
    symbol: optionsData.underlyingSymbol ?? parsedSymbol,
    currentPrice: getCurrentPrice(optionsData.quote),
    expirationDates: Array.isArray(optionsData.expirationDates)
      ? optionsData.expirationDates.map(toISODate).filter(Boolean)
      : [],
    strikes: Array.isArray(optionsData.strikes)
      ? optionsData.strikes.map((s) => toNumber(s)).filter((s) => s !== null)
      : [],
    hasMiniOptions: Boolean(optionsData.hasMiniOptions),
  };
}

async function getOptionChainTool({ symbol, expiration = null }) {
  const parsedSymbol = parseSymbol(symbol);
  const optionsData = await fetchOptions(parsedSymbol, expiration);
  const selected = Array.isArray(optionsData.options) ? optionsData.options[0] : null;

  if (!selected) {
    throw badRequest("No option chain found for this symbol / expiration.");
  }

  const calls = Array.isArray(selected.calls)
    ? selected.calls.map(parseOptionContract).sort((a, b) => a.strike - b.strike)
    : [];

  const puts = Array.isArray(selected.puts)
    ? selected.puts.map(parseOptionContract).sort((a, b) => a.strike - b.strike)
    : [];

  return {
    symbol: optionsData.underlyingSymbol ?? parsedSymbol,
    currentPrice: getCurrentPrice(optionsData.quote),
    expiration: toISODate(selected.expirationDate),
    availableExpirations: Array.isArray(optionsData.expirationDates)
      ? optionsData.expirationDates.map(toISODate).filter(Boolean)
      : [],
    strikes: Array.isArray(optionsData.strikes)
      ? optionsData.strikes.map((s) => toNumber(s)).filter((s) => s !== null)
      : [],
    calls,
    puts,
  };
}

async function getExpectedMoveTool({ symbol, expiration }) {
  const parsedSymbol = parseSymbol(symbol);
  const parsedExpiration = parseExpirationInput(expiration);

  if (!parsedExpiration) {
    throw badRequest("Parameter 'expiration' is required for get_expected_move.");
  }

  const optionsData = await fetchOptions(parsedSymbol, parsedExpiration);
  const selected = Array.isArray(optionsData.options) ? optionsData.options[0] : null;

  if (!selected) {
    throw badRequest("No option chain found for this symbol / expiration.");
  }

  const currentPrice = getCurrentPrice(optionsData.quote);
  if (currentPrice === null) {
    throw badRequest("Unable to determine current underlying price.");
  }

  const calls = Array.isArray(selected.calls) ? selected.calls : [];
  const puts = Array.isArray(selected.puts) ? selected.puts : [];

  const atmCall = pickClosestStrike(calls, currentPrice, "call");
  const atmPut = pickClosestStrike(puts, currentPrice, "put");

  const callMid = atmCall ? safeMid(atmCall.bid, atmCall.ask, atmCall.lastPrice) : null;
  const putMid = atmPut ? safeMid(atmPut.bid, atmPut.ask, atmPut.lastPrice) : null;

  let expectedMove = null;
  let method = null;

  if (callMid !== null && putMid !== null) {
    expectedMove = callMid + putMid;
    method = "atm_straddle_mid";
  } else {
    const ivs = [];
    if (atmCall?.impliedVolatility != null) ivs.push(Number(atmCall.impliedVolatility));
    if (atmPut?.impliedVolatility != null) ivs.push(Number(atmPut.impliedVolatility));

    const avgIv =
      ivs.length > 0 ? ivs.reduce((sum, v) => sum + v, 0) / ivs.length : null;

    const dte = daysToExpiration(parsedExpiration);

    if (avgIv !== null && dte !== null) {
      expectedMove = currentPrice * avgIv * Math.sqrt(dte / 365);
      method = "iv_fallback";
    }
  }

  if (expectedMove === null) {
    throw badRequest("Unable to compute expected move from available option data.");
  }

  const lowerBound = currentPrice - expectedMove;
  const upperBound = currentPrice + expectedMove;

  return {
    symbol: optionsData.underlyingSymbol ?? parsedSymbol,
    expiration: toISODate(parsedExpiration),
    currentPrice: round(currentPrice, 4),
    expectedMove: round(expectedMove, 4),
    expectedMovePercent: round((expectedMove / currentPrice) * 100, 4),
    oneSigmaRange: {
      lower: round(lowerBound, 4),
      upper: round(upperBound, 4),
    },
    method,
    atm: {
      call: atmCall ? parseOptionContract(atmCall) : null,
      put: atmPut ? parseOptionContract(atmPut) : null,
    },
  };
}

async function getBestStrikeTool({
  symbol,
  expiration,
  option_type = "call",
  target_price = null,
  percent_otm = 0,
}) {
  const parsedSymbol = parseSymbol(symbol);
  const parsedExpiration = parseExpirationInput(expiration);

  if (!parsedExpiration) {
    throw badRequest("Parameter 'expiration' is required for get_best_strike.");
  }

  const normalizedType = String(option_type || "").trim().toLowerCase();

  if (!["call", "put"].includes(normalizedType)) {
    throw badRequest("Parameter 'option_type' must be 'call' or 'put'.");
  }

  const otm = toNumber(percent_otm) ?? 0;
  const manualTarget = toNumber(target_price);

  const optionsData = await fetchOptions(parsedSymbol, parsedExpiration);
  const selected = Array.isArray(optionsData.options) ? optionsData.options[0] : null;

  if (!selected) {
    throw badRequest("No option chain found for this symbol / expiration.");
  }

  const currentPrice = getCurrentPrice(optionsData.quote);
  if (currentPrice === null) {
    throw badRequest("Unable to determine current underlying price.");
  }

  const contracts =
    normalizedType === "call"
      ? (Array.isArray(selected.calls) ? selected.calls : [])
      : (Array.isArray(selected.puts) ? selected.puts : []);

  if (contracts.length === 0) {
    throw badRequest(`No ${normalizedType} contracts found for this expiration.`);
  }

  let referenceStrike = manualTarget;

  if (referenceStrike === null) {
    if (normalizedType === "call") {
      referenceStrike = currentPrice * (1 + otm / 100);
    } else {
      referenceStrike = currentPrice * (1 - otm / 100);
    }
  }

  const best = pickClosestStrike(contracts, referenceStrike, normalizedType);
  if (!best) {
    throw badRequest("Unable to find a matching strike.");
  }

  return {
    symbol: optionsData.underlyingSymbol ?? parsedSymbol,
    expiration: toISODate(parsedExpiration),
    optionType: normalizedType,
    currentPrice: round(currentPrice, 4),
    referenceStrike: round(referenceStrike, 4),
    percentOTMUsed: round(otm, 4),
    bestStrike: parseOptionContract(best),
  };
}

const tools = {
  get_quote: getQuoteTool,
  get_option_expirations: getOptionExpirationsTool,
  get_option_chain: getOptionChainTool,
  get_expected_move: getExpectedMoveTool,
  get_best_strike: getBestStrikeTool,
};

/* --------------------------- http fallback -------------------------- */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "wheel-mcp",
    version: "2.0.0",
    mcp: "/mcp",
    tools: Object.keys(tools),
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/tools", (_req, res) => {
  res.json({
    ok: true,
    tools: [
      { name: "get_quote", input: { symbol: "string" } },
      { name: "get_option_expirations", input: { symbol: "string" } },
      { name: "get_option_chain", input: { symbol: "string", expiration: "YYYY-MM-DD | optional" } },
      { name: "get_expected_move", input: { symbol: "string", expiration: "YYYY-MM-DD" } },
      {
        name: "get_best_strike",
        input: {
          symbol: "string",
          expiration: "YYYY-MM-DD",
          option_type: "call | put",
          target_price: "number | optional",
          percent_otm: "number | optional",
        },
      },
    ],
  });
});

app.post("/tools/:toolName", async (req, res) => {
  try {
    const { toolName } = req.params;
    const handler = tools[toolName];

    if (!handler) {
      throw badRequest(`Unknown tool '${toolName}'.`);
    }

    const result = await handler(req.body || {});
    res.json({ ok: true, tool: toolName, result });
  } catch (error) {
    const status = error?.status || 500;
    res.status(status).json({
      ok: false,
      error: error?.message || "Internal server error",
      details: error?.details || null,
    });
  }
});

/* ------------------------------ MCP ------------------------------ */

const transports = new Map();

function createMcpServer() {
  const server = new McpServer({
    name: "wheel-mcp",
    version: "2.0.0",
  });

  server.tool(
    "get_quote",
    "Get a live stock quote from Yahoo Finance.",
    {
      symbol: z.string().min(1),
    },
    async ({ symbol }) => {
      const result = await getQuoteTool({ symbol });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_option_expirations",
    "Get available option expirations and strikes for a ticker.",
    {
      symbol: z.string().min(1),
    },
    async ({ symbol }) => {
      const result = await getOptionExpirationsTool({ symbol });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_option_chain",
    "Get the full option chain for a ticker and expiration.",
    {
      symbol: z.string().min(1),
      expiration: z.string().optional(),
    },
    async ({ symbol, expiration }) => {
      const result = await getOptionChainTool({ symbol, expiration });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_expected_move",
    "Get the expected move for a ticker using the ATM straddle mid price.",
    {
      symbol: z.string().min(1),
      expiration: z.string().min(1),
    },
    async ({ symbol, expiration }) => {
      const result = await getExpectedMoveTool({ symbol, expiration });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_best_strike",
    "Find the best strike nearest a target or percent OTM.",
    {
      symbol: z.string().min(1),
      expiration: z.string().min(1),
      option_type: z.enum(["call", "put"]).default("call"),
      target_price: z.number().optional(),
      percent_otm: z.number().optional(),
    },
    async ({ symbol, expiration, option_type, target_price, percent_otm }) => {
      const result = await getBestStrikeTool({
        symbol,
        expiration,
        option_type,
        target_price,
        percent_otm,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );

  return server;
}

// SSE endpoint for MCP clients to connect
app.get("/mcp", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer();

  transports.set(transport.sessionId, { transport, server });

  res.on("close", async () => {
    transports.delete(transport.sessionId);
    try {
      await server.close();
    } catch {}
  });

  await server.connect(transport);
});

// Message endpoint for the connected SSE session
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId || typeof sessionId !== "string") {
    return res.status(400).json({
      ok: false,
      error: "Missing sessionId query parameter.",
    });
  }

  const record = transports.get(sessionId);
  if (!record) {
    return res.status(404).json({
      ok: false,
      error: "Session not found.",
    });
  }

  try {
    await record.transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error?.message || "Failed to handle MCP message.",
    });
  }
});

/* ---------------------------- errors ---------------------------- */

app.use((error, _req, res, _next) => {
  const status = error?.status || 500;
  res.status(status).json({
    ok: false,
    error: error?.message || "Internal server error",
    details: error?.details || null,
  });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});