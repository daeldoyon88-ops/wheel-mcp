import YahooFinance from "yahoo-finance2";
import { MarketDataProvider } from "./marketDataProvider.js";

export class YahooMarketDataProvider extends MarketDataProvider {
  constructor() {
    super();
    this.client = new YahooFinance({
      suppressNotices: ["yahooSurvey"],
    });
    this.cache = new Map();
    this.quoteTtlMs = 30_000;
    this.optionsTtlMs = 60_000;
    this.chartTtlMs = 60_000;
    this.debugCache = String(process.env.DEBUG_YAHOO_CACHE || "").toLowerCase() === "true";
  }

  _getCached(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      if (this.debugCache) console.log("[YAHOO_CACHE] miss", key);
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      if (this.debugCache) console.log("[YAHOO_CACHE] miss_expired", key);
      return null;
    }
    if (this.debugCache) console.log("[YAHOO_CACHE] hit", key);
    return entry.value;
  }

  _setCached(key, value, ttlMs) {
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  async _getOrFetch(key, ttlMs, fetcher) {
    const cached = this._getCached(key);
    if (cached != null) return cached;
    const fresh = await fetcher();
    this._setCached(key, fresh, ttlMs);
    return fresh;
  }

  async getQuote(symbol) {
    const key = `quote:${String(symbol).trim().toUpperCase()}`;
    return this._getOrFetch(key, this.quoteTtlMs, async () => this.client.quote(symbol));
  }

  async getOptions(symbol, params = undefined) {
    const dateToken =
      params == null || params.date == null ? "all" : new Date(params.date).toISOString().slice(0, 10);
    const key = `options:${String(symbol).trim().toUpperCase()}:${dateToken}`;
    return this._getOrFetch(key, this.optionsTtlMs, async () => {
      if (params == null) {
        return this.client.options(symbol);
      }
      return this.client.options(symbol, params);
    });
  }

  async getChart(symbol, params) {
    const periodToken =
      params?.period1 != null ? new Date(params.period1).toISOString().slice(0, 10) : "none";
    const intervalToken = params?.interval ?? "none";
    const key = `chart:${String(symbol).trim().toUpperCase()}:${periodToken}:${intervalToken}`;
    return this._getOrFetch(key, this.chartTtlMs, async () => this.client.chart(symbol, params));
  }
}
