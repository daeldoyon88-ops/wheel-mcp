import { IBKR_CONFIG, assertIbkrReadOnly } from "../app/config/ibkr.js";
import { IbkrReadOnlyProvider } from "../app/data_providers/ibkrReadOnlyProvider.js";
import { adaptIbkrQuoteToMarketServiceShape } from "../app/services/ibkrMarketAdapter.js";

const symbols = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["AAPL", "MSFT", "SPY"];

async function main() {
  assertIbkrReadOnly();
  const provider = new IbkrReadOnlyProvider();
  try {
    console.log("[IBKR READONLY TEST] config", {
      host: IBKR_CONFIG.host,
      port: IBKR_CONFIG.port,
      clientId: IBKR_CONFIG.clientId,
      readOnly: IBKR_CONFIG.readOnly,
    });
    for (const symbol of symbols) {
      const quote = await provider.getQuote(symbol);
      const adapted = adaptIbkrQuoteToMarketServiceShape(quote);
      console.log(JSON.stringify({ symbol, raw: quote, adapted }, null, 2));
    }
    console.log("[IBKR READONLY TEST] success");
  } finally {
    await provider.disconnect();
  }
}

main().catch((error) => {
  console.error("[IBKR READONLY TEST] failed:", error?.message || error);
  process.exit(1);
});
