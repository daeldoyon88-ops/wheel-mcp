import { YahooMarketDataProvider } from "./yahooMarketDataProvider.js";

/** True on Render.com and similar (IBKR / TWS must never run in this environment). */
function isRenderHost() {
  return String(process.env.RENDER || "").toLowerCase() === "true";
}

/**
 * @returns {import("./yahooMarketDataProvider.js").YahooMarketDataProvider}
 */
export function createMarketDataProvider() {
  const raw = (process.env.MARKET_DATA_PROVIDER || "yahoo").trim().toLowerCase();

  if (raw === "yahoo") {
    return new YahooMarketDataProvider();
  }

  if (raw === "ibkr") {
    if (isRenderHost()) {
      throw new Error(
        "IBKR market data is disabled on Render; use Yahoo (default) or do not set MARKET_DATA_PROVIDER."
      );
    }
    throw new Error("IBKR provider incomplete for scanner");
  }

  throw new Error(`Unknown MARKET_DATA_PROVIDER "${raw}" (use yahoo)`);
}
