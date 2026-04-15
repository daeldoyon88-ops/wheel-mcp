import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import YahooFinance from "yahoo-finance2";
import { z } from "zod";
import http from "node:http";

const yahooFinance = new YahooFinance();

function createMcpServer() {
  const server = new McpServer({
    name: "wheel-live-data",
    version: "1.0.0"
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
          price: q.regularMarketPrice ?? null,
          volume: q.regularMarketVolume ?? null,
          previousClose: q.regularMarketPreviousClose ?? null,
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

httpServer.listen(3000, "0.0.0.0", () => {
  console.log("MCP running on http://0.0.0.0:3000/mcp");
});