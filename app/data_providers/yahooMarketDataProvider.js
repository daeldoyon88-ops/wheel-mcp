import YahooFinance from "yahoo-finance2";
import { MarketDataProvider } from "./marketDataProvider.js";

export class YahooMarketDataProvider extends MarketDataProvider {
  constructor() {
    super();
    this.client = new YahooFinance({
      suppressNotices: ["yahooSurvey"],
    });
  }

  async getQuote(symbol) {
    return this.client.quote(symbol);
  }

  async getOptions(symbol, params = undefined) {
    if (params == null) {
      return this.client.options(symbol);
    }
    return this.client.options(symbol, params);
  }

  async getChart(symbol, params) {
    return this.client.chart(symbol, params);
  }
}
