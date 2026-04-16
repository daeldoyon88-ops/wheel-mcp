import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import yahooFinance from "yahoo-finance2";
import { z } from "zod";
import http from "node:http";

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createMcpServer() {
  const server = new McpServer({
    name: "wheel-live-data",
    version: "2.0.0"
  });

  // =========================
  // QUOTE
  // =========================
  server.registerTool(
    "get_quote",
    {
      title: "Get stock quote",
      inputSchema: { ticker: z.string() }
    },
    async ({ ticker }) => {
      const symbol = ticker.toUpperCase();
      const q = await yahooFinance.quote(symbol);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ticker: symbol,
              price: q.regularMarketPrice,
              volume: q.regularMarketVolume
            }, null, 2)
          }
        ]
      };
    }
  );

  // =========================
  // EXPIRATIONS
  // =========================
  server.registerTool(
    "get_option_expirations",
    {
      title: "Get expirations",
      inputSchema: { ticker: z.string() }
    },
    async ({ ticker }) => {
      const symbol = ticker.toUpperCase();
      const data = await yahooFinance.options(symbol);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ticker: symbol,
              expirations: data.expirationDates
            }, null, 2)
          }
        ]
      };
    }
  );

  // =========================
  // OPTION CHAIN (FIXED)
  // =========================
  server.registerTool(
    "get_option_chain",
    {
      title: "Get option chain",
      inputSchema: {
        ticker: z.string(),
        expiration: z.string()
      }
    },
    async ({ ticker, expiration }) => {
      const symbol = ticker.toUpperCase();

      const data = await yahooFinance.options(symbol, {
        date: new Date(expiration)
      });

      const chain = data.options?.[0];

      if (!chain) {
        throw new Error("No option chain returned");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ticker: symbol,
              expiration,
              calls: chain.calls,
              puts: chain.puts
            }, null, 2)
          }
        ]
      };
    }
  );

  // =========================
  // EXPECTED MOVE
  // =========================
  server.registerTool(
    "get_expected_move",
    {
      title: "Expected move",
      inputSchema: {
        ticker: z.string(),
        expiration: z.string()
      }
    },
    async ({ ticker, expiration }) => {
      const symbol = ticker.toUpperCase();

      const quote = await yahooFinance.quote(symbol);
      const data = await yahooFinance.options(symbol, {
        date: new Date(expiration)
      });

      const chain = data.options?.[0];
      const price = quote.regularMarketPrice;

      const atm = chain.calls.sort(
        (a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price)
      )[0];

      const iv = atm.impliedVolatility;

      const expectedMove = price * iv * Math.sqrt(7 / 365);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              price,
              iv,
              expectedMove,
              range: {
                low: price - expectedMove,
                high: price + expectedMove
              }
            }, null, 2)
          }
        ]
      };
    }
  );

  // =========================
  // BEST STRIKE
  // =========================
  server.registerTool(
    "get_best_strike",
    {
      title: "Best strike",
      inputSchema: {
        ticker: z.string(),
        bias: z.enum(["bullish", "bearish"]),
        expiration: z.string()
      }
    },
    async ({ ticker, bias, expiration }) => {
      const symbol = ticker.toUpperCase();

      const quote = await yahooFinance.quote(symbol);
      const data = await yahooFinance.options(symbol, {
        date: new Date(expiration)
      });

      const chain = data.options?.[0];
      const price = quote.regularMarketPrice;

      const contracts =
        bias === "bullish" ? chain.calls : chain.puts;

      const best = contracts
        .filter(c => c.volume > 10)
        .sort((a, b) =>
          Math.abs(a.strike - price) - Math.abs(b.strike - price)
        )[0];

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              price,
              strike: best.strike,
              premium: best.lastPrice,
              volume: best.volume
            }, null, 2)
          }
        ]
      };
    }
  );

  return server;
}

// =========================
// SERVER
// =========================
const httpServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/mcp") {
    const server = createMcpServer();
    const transport = new StreamableHTTPServerTransport({});

    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end();
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP running on ${PORT}`);
});