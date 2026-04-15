import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import YahooFinance from "yahoo-finance2";
import { z } from "zod";
import http from "node:http";

const yahooFinance = new YahooFinance();

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function daysToExpiry(expirationDate) {
  const now = new Date();
  const expiry = new Date(expirationDate);
  const diffMs = expiry.getTime() - now.getTime();
  return Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

function createMcpServer() {
  const server = new McpServer({
    name: "wheel-live-data",
    version: "1.1.0"
  });

  server.registerTool(
    "get_quote",
    {
      title: "Get stock quote",
      description: "Get live stock price",
      inputSchema: {
        ticker: z.string()
      }
    },
    async ({ ticker }) => {
      try {
        const symbol = ticker.toUpperCase().trim();
        const q = await yahooFinance.quote(symbol);

        const payload = {
          ticker: symbol,
          price: safeNumber(q.regularMarketPrice),
          volume: safeNumber(q.regularMarketVolume),
          previousClose: safeNumber(q.regularMarketPreviousClose),
          currency: q.currency ?? null,
          exchange: q.fullExchangeName ?? null,
          timestamp: new Date().toISOString()
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2)
            }
          ],
          structuredContent: payload
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "quote_failed",
                  message: e.message
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "get_option_chain",
    {
      title: "Get option chain",
      description: "Get full option chain for a ticker and expiration date",
      inputSchema: {
        ticker: z.string(),
        expiration: z.string().optional()
      }
    },
    async ({ ticker, expiration }) => {
      try {
        const symbol = ticker.toUpperCase().trim();
        const chain = expiration
          ? await yahooFinance.options(symbol, { date: expiration })
          : await yahooFinance.options(symbol);

        const quotePrice =
          safeNumber(chain?.quote?.regularMarketPrice) ??
          safeNumber(chain?.underlyingSymbol ? null : null);

        const calls = (chain.calls ?? []).map((c) => ({
          contractSymbol: c.contractSymbol ?? null,
          strike: safeNumber(c.strike),
          lastPrice: safeNumber(c.lastPrice),
          bid: safeNumber(c.bid),
          ask: safeNumber(c.ask),
          change: safeNumber(c.change),
          percentChange: safeNumber(c.percentChange),
          volume: safeNumber(c.volume),
          openInterest: safeNumber(c.openInterest),
          impliedVolatility: safeNumber(c.impliedVolatility),
          inTheMoney: c.inTheMoney ?? null,
          expiration: c.expiration ?? expiration ?? null
        }));

        const puts = (chain.puts ?? []).map((p) => ({
          contractSymbol: p.contractSymbol ?? null,
          strike: safeNumber(p.strike),
          lastPrice: safeNumber(p.lastPrice),
          bid: safeNumber(p.bid),
          ask: safeNumber(p.ask),
          change: safeNumber(p.change),
          percentChange: safeNumber(p.percentChange),
          volume: safeNumber(p.volume),
          openInterest: safeNumber(p.openInterest),
          impliedVolatility: safeNumber(p.impliedVolatility),
          inTheMoney: p.inTheMoney ?? null,
          expiration: p.expiration ?? expiration ?? null
        }));

        const payload = {
          ticker: symbol,
          expiration:
            expiration ??
            calls[0]?.expiration ??
            puts[0]?.expiration ??
            null,
          underlyingPrice: quotePrice,
          calls,
          puts,
          timestamp: new Date().toISOString()
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2)
            }
          ],
          structuredContent: payload
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "option_chain_failed",
                  message: e.message
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "get_expected_move",
    {
      title: "Get expected move",
      description: "Calculate expected move from ATM implied volatility and expiration",
      inputSchema: {
        ticker: z.string(),
        expiration: z.string().optional()
      }
    },
    async ({ ticker, expiration }) => {
      try {
        const symbol = ticker.toUpperCase().trim();
        const quote = await yahooFinance.quote(symbol);
        const chain = expiration
          ? await yahooFinance.options(symbol, { date: expiration })
          : await yahooFinance.options(symbol);

        const price = safeNumber(quote.regularMarketPrice);
        if (!price) {
          throw new Error("Unable to get underlying price.");
        }

        const expiry =
          expiration ??
          chain.calls?.[0]?.expiration ??
          chain.puts?.[0]?.expiration;

        if (!expiry) {
          throw new Error("Unable to determine expiration date.");
        }

        const calls = chain.calls ?? [];
        const puts = chain.puts ?? [];
        const allContracts = [...calls, ...puts].filter(
          (c) =>
            typeof c.strike === "number" &&
            typeof c.impliedVolatility === "number" &&
            Number.isFinite(c.impliedVolatility)
        );

        if (!allContracts.length) {
          throw new Error("No contracts with implied volatility found.");
        }

        const atm = allContracts.sort(
          (a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price)
        )[0];

        const iv = safeNumber(atm.impliedVolatility);
        const dte = daysToExpiry(expiry);
        const expectedMove = price * iv * Math.sqrt(dte / 365);

        const payload = {
          ticker: symbol,
          underlyingPrice: price,
          expiration: expiry,
          dte,
          atmStrike: safeNumber(atm.strike),
          impliedVolatility: iv,
          expectedMoveDollar: safeNumber(expectedMove),
          expectedMovePercent: safeNumber((expectedMove / price) * 100),
          lowerBound: safeNumber(price - expectedMove),
          upperBound: safeNumber(price + expectedMove),
          timestamp: new Date().toISOString()
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2)
            }
          ],
          structuredContent: payload
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "expected_move_failed",
                  message: e.message
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );

  server.registerTool(
    "get_best_strike",
    {
      title: "Get best strike",
      description:
        "Pick a live best strike from the option chain based on bias and nearest ATM with liquidity",
      inputSchema: {
        ticker: z.string(),
        bias: z.enum(["bullish", "bearish"]),
        expiration: z.string().optional()
      }
    },
    async ({ ticker, bias, expiration }) => {
      try {
        const symbol = ticker.toUpperCase().trim();
        const quote = await yahooFinance.quote(symbol);
        const chain = expiration
          ? await yahooFinance.options(symbol, { date: expiration })
          : await yahooFinance.options(symbol);

        const price = safeNumber(quote.regularMarketPrice);
        if (!price) {
          throw new Error("Unable to get underlying price.");
        }

        const expiry =
          expiration ??
          chain.calls?.[0]?.expiration ??
          chain.puts?.[0]?.expiration ??
          null;

        const contracts = bias === "bullish" ? chain.calls ?? [] : chain.puts ?? [];

        const filtered = contracts.filter(
          (c) =>
            typeof c.strike === "number" &&
            Number.isFinite(c.strike) &&
            safeNumber(c.volume) !== null &&
            safeNumber(c.openInterest) !== null
        );

        if (!filtered.length) {
          throw new Error("No liquid contracts found.");
        }

        const ranked = filtered
          .map((c) => {
            const strike = safeNumber(c.strike);
            const volume = safeNumber(c.volume) ?? 0;
            const openInterest = safeNumber(c.openInterest) ?? 0;
            const distance = Math.abs(strike - price);
            const liquidityScore = volume + openInterest;

            return {
              contract: c,
              distance,
              liquidityScore
            };
          })
          .sort((a, b) => {
            if (a.distance !== b.distance) return a.distance - b.distance;
            return b.liquidityScore - a.liquidityScore;
          });

        const best = ranked[0].contract;

        const payload = {
          ticker: symbol,
          bias,
          underlyingPrice: price,
          expiration: expiry,
          bestStrike: safeNumber(best.strike),
          lastPrice: safeNumber(best.lastPrice),
          bid: safeNumber(best.bid),
          ask: safeNumber(best.ask),
          volume: safeNumber(best.volume),
          openInterest: safeNumber(best.openInterest),
          impliedVolatility: safeNumber(best.impliedVolatility),
          contractSymbol: best.contractSymbol ?? null,
          inTheMoney: best.inTheMoney ?? null,
          timestamp: new Date().toISOString()
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(payload, null, 2)
            }
          ],
          structuredContent: payload
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "best_strike_failed",
                  message: e.message
                },
                null,
                2
              )
            }
          ]
        };
      }
    }
  );

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === "POST" && req.url === "/mcp") {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
      });

      res.on("close", async () => {
        try {
          await transport.close();
        } catch {}
        try {
          await server.close();
        } catch {}
      });

      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "server_error",
        message: err.message
      })
    );
  }
});

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`MCP running on http://0.0.0.0:${PORT}/mcp`);
});