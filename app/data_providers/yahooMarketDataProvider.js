import YahooFinance from "yahoo-finance2";
import { MarketDataProvider } from "./marketDataProvider.js";

export class YahooMarketDataProvider extends MarketDataProvider {
  constructor() {
    super();
    this.client = new YahooFinance({
      suppressNotices: ["yahooSurvey"],
    });
    this.cache = new Map();
    this.inFlight = new Map();
    this.quoteTtlMs = 30_000;
    this.optionsTtlMs = 60_000;
    this.chartTtlMs = 60_000;
    this.debugCache = String(process.env.DEBUG_YAHOO_CACHE || "").toLowerCase() === "true";
    this.metrics = this._buildEmptyMetrics();
  }

  _buildEmptyMetrics() {
    const nowIso = new Date().toISOString();
    return {
      startedAt: nowIso,
      lastUpdatedAt: nowIso,
      totals: {
        totalYahooRealCalls: 0,
        totalYahooCacheHits: 0,
        totalYahooCacheMisses: 0,
        quoteCalls: 0,
        quoteCacheHits: 0,
        quoteCacheMisses: 0,
        optionsAllCalls: 0,
        optionsAllCacheHits: 0,
        optionsAllCacheMisses: 0,
        optionsDateCalls: 0,
        optionsDateCacheHits: 0,
        optionsDateCacheMisses: 0,
        chartCalls: 0,
        chartCacheHits: 0,
        chartCacheMisses: 0,
        chart120dCalls: 0,
        chart180dCalls: 0,
      },
      bySymbol: {},
    };
  }

  _ensureSymbolMetrics(symbol) {
    const key = String(symbol || "").trim().toUpperCase();
    if (!key) return null;
    if (!this.metrics.bySymbol[key]) {
      this.metrics.bySymbol[key] = {
        totalYahooRealCalls: 0,
        totalYahooCacheHits: 0,
        totalYahooCacheMisses: 0,
        quoteCalls: 0,
        quoteCacheHits: 0,
        quoteCacheMisses: 0,
        optionsAllCalls: 0,
        optionsAllCacheHits: 0,
        optionsAllCacheMisses: 0,
        optionsDateCalls: 0,
        optionsDateCacheHits: 0,
        optionsDateCacheMisses: 0,
        chartCalls: 0,
        chartCacheHits: 0,
        chartCacheMisses: 0,
        chart120dCalls: 0,
        chart180dCalls: 0,
      };
    }
    return this.metrics.bySymbol[key];
  }

  _incrementMetric(metricName, symbol) {
    if (!metricName) return;
    this.metrics.totals[metricName] = (this.metrics.totals[metricName] || 0) + 1;
    const symbolMetrics = this._ensureSymbolMetrics(symbol);
    if (symbolMetrics) {
      symbolMetrics[metricName] = (symbolMetrics[metricName] || 0) + 1;
    }
    this.metrics.lastUpdatedAt = new Date().toISOString();
  }

  _recordCacheHit(meta = {}) {
    const { bucket, symbol } = meta;
    this._incrementMetric("totalYahooCacheHits", symbol);
    if (bucket === "quote") this._incrementMetric("quoteCacheHits", symbol);
    if (bucket === "options_all") this._incrementMetric("optionsAllCacheHits", symbol);
    if (bucket === "options_date") this._incrementMetric("optionsDateCacheHits", symbol);
    if (bucket === "chart") this._incrementMetric("chartCacheHits", symbol);
  }

  _recordCacheMiss(meta = {}) {
    const { bucket, symbol } = meta;
    this._incrementMetric("totalYahooCacheMisses", symbol);
    if (bucket === "quote") this._incrementMetric("quoteCacheMisses", symbol);
    if (bucket === "options_all") this._incrementMetric("optionsAllCacheMisses", symbol);
    if (bucket === "options_date") this._incrementMetric("optionsDateCacheMisses", symbol);
    if (bucket === "chart") this._incrementMetric("chartCacheMisses", symbol);
  }

  _recordRealCall(meta = {}) {
    const { bucket, symbol, chartLookbackDays } = meta;
    this._incrementMetric("totalYahooRealCalls", symbol);
    if (bucket === "quote") this._incrementMetric("quoteCalls", symbol);
    if (bucket === "options_all") this._incrementMetric("optionsAllCalls", symbol);
    if (bucket === "options_date") this._incrementMetric("optionsDateCalls", symbol);
    if (bucket === "chart") this._incrementMetric("chartCalls", symbol);
    if (bucket === "chart" && chartLookbackDays === 120) this._incrementMetric("chart120dCalls", symbol);
    if (bucket === "chart" && chartLookbackDays === 180) this._incrementMetric("chart180dCalls", symbol);
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

  async _getOrFetch(key, ttlMs, fetcher, meta = undefined) {
    const cached = this._getCached(key);
    if (cached != null) {
      this._recordCacheHit(meta);
      return cached;
    }
    const inFlight = this.inFlight.get(key);
    if (inFlight) {
      this._recordCacheHit(meta);
      return inFlight;
    }
    this._recordCacheMiss(meta);
    this._recordRealCall(meta);
    const promise = (async () => {
      try {
        const fresh = await fetcher();
        this._setCached(key, fresh, ttlMs);
        return fresh;
      } finally {
        this.inFlight.delete(key);
      }
    })();
    this.inFlight.set(key, promise);
    return promise;
  }

  async getQuote(symbol) {
    const normalizedSymbol = String(symbol).trim().toUpperCase();
    const key = `quote:${normalizedSymbol}`;
    return this._getOrFetch(
      key,
      this.quoteTtlMs,
      async () => this.client.quote(symbol),
      { bucket: "quote", symbol: normalizedSymbol }
    );
  }

  async getOptions(symbol, params = undefined) {
    const normalizedSymbol = String(symbol).trim().toUpperCase();
    const dateToken =
      params == null || params.date == null ? "all" : new Date(params.date).toISOString().slice(0, 10);
    const bucket = dateToken === "all" ? "options_all" : "options_date";
    const key = `options:${normalizedSymbol}:${dateToken}`;
    return this._getOrFetch(key, this.optionsTtlMs, async () => {
      if (params == null) {
        return this.client.options(symbol);
      }
      return this.client.options(symbol, params);
    }, { bucket, symbol: normalizedSymbol });
  }

  async getChart(symbol, params) {
    const normalizedSymbol = String(symbol).trim().toUpperCase();
    const periodToken =
      params?.period1 != null ? new Date(params.period1).toISOString().slice(0, 10) : "none";
    const intervalToken = params?.interval ?? "none";
    const key = `chart:${normalizedSymbol}:${periodToken}:${intervalToken}`;
    let chartLookbackDays = null;
    if (params?.period1 != null) {
      const periodDate = new Date(params.period1);
      if (!Number.isNaN(periodDate.getTime())) {
        const days = Math.round((Date.now() - periodDate.getTime()) / (1000 * 60 * 60 * 24));
        if (days >= 115 && days <= 125) chartLookbackDays = 120;
        else if (days >= 175 && days <= 185) chartLookbackDays = 180;
      }
    }
    return this._getOrFetch(
      key,
      this.chartTtlMs,
      async () => this.client.chart(symbol, params),
      { bucket: "chart", symbol: normalizedSymbol, chartLookbackDays }
    );
  }

  getScanMetrics() {
    return JSON.parse(JSON.stringify(this.metrics));
  }

  resetScanMetrics() {
    this.metrics = this._buildEmptyMetrics();
    return this.getScanMetrics();
  }
}
