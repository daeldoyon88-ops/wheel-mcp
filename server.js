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

async function getAvailableExpirations(symbol) {
  const base = await yahooFinance.options(symbol);
  const expirations = Array.isArray(base?.expirationDates)
    ? base.expirationDates
    : Array.isArray(base?.options)
      ? base.options.map((o) => o?.expirationDate).filter(Boolean)
      : [];

  return [...new Set(expirations)];
}

async function getResolvedChain(symbol, expiration) {
  let selectedExpiration = expiration;

  if (!selectedExpiration) {
    const expirations = await getAvailableExpirations(symbol);
    if (!expirations.length) {
      throw new Error("No option expirations found.");
    }
    selectedExpiration = expirations[0];
  }

  const chain = await yahooFinance.options(symbol, { date: selectedExpiration });

  return {
    chain,
    selectedExpiration
  };
}

function mapContract(contract, fallbackExpiration) {
  return {
    contractSymbol: contract.contractSymbol ?? null,
    strike: safeNumber(contract.strike),
    lastPrice: safeNumber(contract.lastPrice),
    bid: safeNumber(contract.bid),
    ask: safeNumber(contract.ask),
    change: safeNumber(contract.change),
    percentChange: safeNumber(contract.percentChange),
    volume: safeNumber(contract.volume),
    openInterest: safeNumber(contract.openInterest),
    impliedVolatility: safeNumber(contract.impliedVolatility),
    inTheMoney: contract.inTheMoney ?? null,
    expiration: contract.expiration ?? fallbackExpiration ?? null
  };
}

function createMcpServer() {
  const server = new McpServer({
    name: "wheel-live-data",
    version: "1.2.0"
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
    "get_option_expirations",
    {
      title: "Get option expirations",
      description: "Get available option expiration dates for a ticker",
      inputSchema: {
        ticker: z.string()
      }
    },
    async ({ ticker }) => {
      try {
        const symbol = ticker.toUpperCase().trim();
        const expirations = await getAvailableExpirations(symbol);

        const payload = {
          ticker: symbol,
          expirations,
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
                  error: "option_expirations_failed",
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
        const { chain, selectedExpiration } = await getResolvedChain(symbol, expiration);

        const quotePrice =
          safeNumber(chain?.quote?.regularMarketPrice) ??
          safeNumber(chain?.underlyingPrice) ??
          null;

        const calls = (chain.calls ?? []).map((c) => mapContract(c, selectedExpiration));
        const puts = (chain.puts ?? []).map((p) => mapContract(p, selectedExpiration));

        const payload = {
          ticker: symbol,
          expiration: selectedExpiration,
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
        const { chain, selectedExpiration } = await getResolvedChain(symbol, expiration);

        const price = safeNumber(quote.regularMarketPrice);
        if (!price) {
          throw new Error("Unable to get underlying price.");
        }

        const calls = chain.calls ?? [];
        const puts = chain.puts ?? [];
        const allContracts = [...calls, ...puts].filter(
          (c) =>
            typeof c.strike === "number" &&
            Number.isFinite(c.strike) &&
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
        if (!iv) {
          throw new Error("Unable to determine ATM implied volatility.");
        }

        const dte = daysToExpiry(selectedExpiration);
        const expectedMove = price * iv * Math.sqrt(dte / 365);

        const payload = {
          ticker: symbol,
          underlyingPrice: price,
          expiration: selectedExpiration,
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
        const { chain, selectedExpiration } = await getResolvedChain(symbol, expiration);

        const price = safeNumber(quote.regularMarketPrice);
        if (!price) {
          throw new Error("Unable to get underlying price.");
        }

        const contracts = bias === "bullish" ? chain.calls ?? [] : chain.puts ?? [];

        const filtered = contracts.filter(
          (c) =>
            typeof c.strike === "number" &&
            Number.isFinite(c.strike) &&
            (
              safeNumber(c.volume) !== null ||
              safeNumber(c.openInterest) !== null ||
              safeNumber(c.bid) !== null ||
              safeNumber(c.ask) !== null
            )
        );

        if (!filtered.length) {
          throw new Error("No usable contracts found.");
        }

        const ranked = filtered
          .map((c) => {
            const strike = safeNumber(c.strike);
            const volume = safeNumber(c.volume) ?? 0;
            const openInterest = safeNumber(c.openInterest) ?? 0;
            const bid = safeNumber(c.bid) ?? 0;
            const ask = safeNumber(c.ask) ?? 0;
            const distance = Math.abs(strike - price);
            const liquidityScore = volume + openInterest + (bid > 0 ? 50 : 0) + (ask > 0 ? 25 : 0);

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
          expiration: selectedExpiration,
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