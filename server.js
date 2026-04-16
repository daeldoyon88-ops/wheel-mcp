import express from "express";
import YahooFinance from "yahoo-finance2";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = "2.2.0";
const yahooFinance = new YahooFinance();
const SERVER_STARTED_AT = new Date();

app.use(express.json({ limit: "1mb" }));

/* --------------------------- request timing --------------------------- */

app.use((req, res, next) => {
  const started = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - started;
    console.log(
      `[HTTP] ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
    );
  });

  next();
});

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

function createTimingTracker() {
  const startedAt = Date.now();
  const marks = {};

  return {
    mark(name, ms) {
      marks[name] = round(ms, 2);
    },
    finish() {
      return {
        ...marks,
        totalMs: round(Date.now() - startedAt, 2),
      };
    },
  };
}

async function fetchOptions(symbol, expiration = null) {
  const parsedSymbol = parseSymbol(symbol);
  const date = parseExpirationInput(expiration);

  if (date) {
    return yahooFinance.options(parsedSymbol, { date });
  }

  return yahooFinance.options(parsedSymbol);
}

/* ------------------------- technical helpers ------------------------- */

function normalizeHistoricalRow(row) {
  const close =
    toNumber(row?.close) ??
    toNumber(row?.adjClose) ??
    toNumber(row?.adjclose) ??
    null;

  const high = toNumber(row?.high);
  const low = toNumber(row?.low);
  const open = toNumber(row?.open);
  const volume = toNumber(row?.volume);

  const date = row?.date ? new Date(row.date) : null;
  if (!date || Number.isNaN(date.getTime()) || close === null) {
    return null;
  }

  return {
    date,
    open,
    high,
    low,
    close,
    volume,
  };
}

function getHistoricalStartDate(range) {
  const now = new Date();
  const start = new Date(now);

  switch (String(range || "1y").toLowerCase()) {
    case "1mo":
      start.setMonth(start.getMonth() - 1);
      break;
    case "3mo":
      start.setMonth(start.getMonth() - 3);
      break;
    case "6mo":
      start.setMonth(start.getMonth() - 6);
      break;
    case "1y":
      start.setFullYear(start.getFullYear() - 1);
      break;
    case "2y":
      start.setFullYear(start.getFullYear() - 2);
      break;
    case "5y":
      start.setFullYear(start.getFullYear() - 5);
      break;
    case "ytd":
      return new Date(now.getFullYear(), 0, 1);
    case "max":
      start.setFullYear(start.getFullYear() - 20);
      break;
    default:
      start.setFullYear(start.getFullYear() - 1);
      break;
  }

  return start;
}

async function fetchHistoricalPrices(symbol, range = "1y", interval = "1d") {
  const parsedSymbol = parseSymbol(symbol);

  const normalizedInterval = String(interval || "1d").toLowerCase();
  if (!["1d", "1wk", "1mo"].includes(normalizedInterval)) {
    throw badRequest("Invalid interval. Use 1d, 1wk, or 1mo.");
  }

  const period1 = getHistoricalStartDate(range);
  const period2 = new Date();

  const rows = await yahooFinance.historical(parsedSymbol, {
    period1,
    period2,
    interval: normalizedInterval,
  });

  return (Array.isArray(rows) ? rows : [])
    .map(normalizeHistoricalRow)
    .filter(Boolean);
}

function getCloses(rows) {
  return rows.map((r) => r.close).filter((v) => typeof v === "number");
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  const sum = slice.reduce((acc, value) => acc + value, 0);
  return sum / period;
}

function emaSeries(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];
  const multiplier = 2 / (period + 1);
  const seed =
    values.slice(0, period).reduce((acc, value) => acc + value, 0) / period;

  const result = [seed];
  for (let i = period; i < values.length; i += 1) {
    const prev = result[result.length - 1];
    result.push((values[i] - prev) * multiplier + prev);
  }
  return result;
}

function ema(values, period) {
  const series = emaSeries(values, period);
  return series.length ? series[series.length - 1] : null;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function atr(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length < period + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < rows.length; i += 1) {
    const current = rows[i];
    const previous = rows[i - 1];

    if (
      current.high === null ||
      current.low === null ||
      previous.close === null
    ) {
      continue;
    }

    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    trueRanges.push(tr);
  }

  if (trueRanges.length < period) return null;

  let atrValue =
    trueRanges.slice(0, period).reduce((acc, value) => acc + value, 0) / period;

  for (let i = period; i < trueRanges.length; i += 1) {
    atrValue = ((atrValue * (period - 1)) + trueRanges[i]) / period;
  }

  return atrValue;
}

function percentDistance(current, reference) {
  if (current === null || reference === null || reference === 0) return null;
  return ((current - reference) / reference) * 100;
}

function rangePosition(current, low, high) {
  if (
    current === null ||
    low === null ||
    high === null ||
    high === low
  ) {
    return null;
  }

  return ((current - low) / (high - low)) * 100;
}

function classifyTrend({
  currentPrice,
  sma20,
  sma50,
  sma200,
  ema8,
  ema21,
  rsi14,
}) {
  let score = 0;

  if (currentPrice !== null && sma20 !== null && currentPrice > sma20) score += 1;
  if (currentPrice !== null && sma50 !== null && currentPrice > sma50) score += 1;
  if (currentPrice !== null && sma200 !== null && currentPrice > sma200) score += 1;
  if (ema8 !== null && ema21 !== null && ema8 > ema21) score += 1;
  if (rsi14 !== null && rsi14 >= 55) score += 1;
  if (rsi14 !== null && rsi14 <= 45) score -= 1;

  if (score >= 4) return "bullish";
  if (score <= 1) return "bearish";
  return "neutral";
}

/* ------------------------------ tools ------------------------------ */

async function getQuoteTool({ symbol }) {
  const timing = createTimingTracker();

  const fetchStarted = Date.now();
  const parsedSymbol = parseSymbol(symbol);
  const quote = await yahooFinance.quote(parsedSymbol);
  timing.mark("fetchMs", Date.now() - fetchStarted);

  const formatStarted = Date.now();
  const result = {
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
  timing.mark("formatMs", Date.now() - formatStarted);

  return {
    ...result,
    timing: timing.finish(),
  };
}

async function getOptionExpirationsTool({ symbol }) {
  const timing = createTimingTracker();

  const fetchStarted = Date.now();
  const parsedSymbol = parseSymbol(symbol);
  const optionsData = await fetchOptions(parsedSymbol);
  timing.mark("fetchMs", Date.now() - fetchStarted);

  const formatStarted = Date.now();
  const result = {
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
  timing.mark("formatMs", Date.now() - formatStarted);

  return {
    ...result,
    timing: timing.finish(),
  };
}

async function getOptionChainTool({ symbol, expiration = null }) {
  const timing = createTimingTracker();

  const fetchStarted = Date.now();
  const parsedSymbol = parseSymbol(symbol);
  const optionsData = await fetchOptions(parsedSymbol, expiration);
  timing.mark("fetchMs", Date.now() - fetchStarted);

  const parseStarted = Date.now();
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

  timing.mark("parseMs", Date.now() - parseStarted);

  const formatStarted = Date.now();
  const result = {
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
  timing.mark("formatMs", Date.now() - formatStarted);

  return {
    ...result,
    timing: timing.finish(),
  };
}

async function getExpectedMoveTool({ symbol, expiration }) {
  const timing = createTimingTracker();

  const validateStarted = Date.now();
  const parsedSymbol = parseSymbol(symbol);
  const parsedExpiration = parseExpirationInput(expiration);

  if (!parsedExpiration) {
    throw badRequest("Parameter 'expiration' is required for get_expected_move.");
  }
  timing.mark("validateMs", Date.now() - validateStarted);

  const fetchStarted = Date.now();
  const optionsData = await fetchOptions(parsedSymbol, parsedExpiration);
  timing.mark("fetchMs", Date.now() - fetchStarted);

  const computeStarted = Date.now();
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
  timing.mark("computeMs", Date.now() - computeStarted);

  const formatStarted = Date.now();
  const result = {
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
  timing.mark("formatMs", Date.now() - formatStarted);

  return {
    ...result,
    timing: timing.finish(),
  };
}

async function getBestStrikeTool({
  symbol,
  expiration,
  option_type = "call",
  target_price = null,
  percent_otm = 0,
}) {
  const timing = createTimingTracker();

  const validateStarted = Date.now();
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
  timing.mark("validateMs", Date.now() - validateStarted);

  const fetchStarted = Date.now();
  const optionsData = await fetchOptions(parsedSymbol, parsedExpiration);
  timing.mark("fetchMs", Date.now() - fetchStarted);

  const computeStarted = Date.now();
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
  timing.mark("computeMs", Date.now() - computeStarted);

  const formatStarted = Date.now();
  const result = {
    symbol: optionsData.underlyingSymbol ?? parsedSymbol,
    expiration: toISODate(parsedExpiration),
    optionType: normalizedType,
    currentPrice: round(currentPrice, 4),
    referenceStrike: round(referenceStrike, 4),
    percentOTMUsed: round(otm, 4),
    bestStrike: parseOptionContract(best),
  };
  timing.mark("formatMs", Date.now() - formatStarted);

  return {
    ...result,
    timing: timing.finish(),
  };
}

async function getTechnicalsTool({ symbol, range = "1y", interval = "1d" }) {
  const timing = createTimingTracker();

  const fetchStarted = Date.now();
  const parsedSymbol = parseSymbol(symbol);
  const rows = await fetchHistoricalPrices(parsedSymbol, range, interval);
  timing.mark("fetchMs", Date.now() - fetchStarted);

  if (!rows.length) {
    throw badRequest("No historical price data found for this symbol.");
  }

  const computeStarted = Date.now();
  const closes = getCloses(rows);
  const latest = rows[rows.length - 1];
  const previous = rows.length > 1 ? rows[rows.length - 2] : null;

  const currentPrice = toNumber(latest?.close);
  const previousClose = toNumber(previous?.close);

  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(rows, 14);

  const recent20 = rows.slice(-20);
  const low20 = recent20.length
    ? Math.min(...recent20.map((r) => r.low).filter((v) => v !== null))
    : null;
  const high20 = recent20.length
    ? Math.max(...recent20.map((r) => r.high).filter((v) => v !== null))
    : null;

  const lows52w = rows.map((r) => r.low).filter((v) => v !== null);
  const highs52w = rows.map((r) => r.high).filter((v) => v !== null);
  const low52w = lows52w.length ? Math.min(...lows52w) : null;
  const high52w = highs52w.length ? Math.max(...highs52w) : null;

  const absoluteChange =
    currentPrice !== null && previousClose !== null
      ? currentPrice - previousClose
      : null;

  const percentChange =
    absoluteChange !== null && previousClose
      ? (absoluteChange / previousClose) * 100
      : null;

  const trend = classifyTrend({
    currentPrice,
    sma20,
    sma50,
    sma200,
    ema8,
    ema21,
    rsi14,
  });
  timing.mark("computeMs", Date.now() - computeStarted);

  const formatStarted = Date.now();
  const result = {
    symbol: parsedSymbol,
    range,
    interval,
    bars: rows.length,
    asOfDate: latest?.date ? latest.date.toISOString() : null,
    currentPrice: round(currentPrice, 4),
    previousClose: round(previousClose, 4),
    change: round(absoluteChange, 4),
    changePercent: round(percentChange, 4),
    indicators: {
      sma20: round(sma20, 4),
      sma50: round(sma50, 4),
      sma200: round(sma200, 4),
      ema8: round(ema8, 4),
      ema21: round(ema21, 4),
      rsi14: round(rsi14, 4),
      atr14: round(atr14, 4),
    },
    distancePercent: {
      vsSma20: round(percentDistance(currentPrice, sma20), 4),
      vsSma50: round(percentDistance(currentPrice, sma50), 4),
      vsSma200: round(percentDistance(currentPrice, sma200), 4),
      vsEma8: round(percentDistance(currentPrice, ema8), 4),
      vsEma21: round(percentDistance(currentPrice, ema21), 4),
    },
    ranges: {
      last20Days: {
        low: round(low20, 4),
        high: round(high20, 4),
        positionPercent: round(rangePosition(currentPrice, low20, high20), 4),
      },
      last52Weeks: {
        low: round(low52w, 4),
        high: round(high52w, 4),
        positionPercent: round(rangePosition(currentPrice, low52w, high52w), 4),
      },
    },
    trend,
  };
  timing.mark("formatMs", Date.now() - formatStarted);

  return {
    ...result,
    timing: timing.finish(),
  };
}

const tools = {
  get_quote: getQuoteTool,
  get_option_expirations: getOptionExpirationsTool,
  get_option_chain: getOptionChainTool,
  get_expected_move: getExpectedMoveTool,
  get_best_strike: getBestStrikeTool,
  get_technicals: getTechnicalsTool,
};

/* --------------------------- http fallback -------------------------- */

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "wheel-mcp",
    version: APP_VERSION,
    mcp: "/mcp",
    tools: Object.keys(tools),
  });
});

app.get("/health", (_req, res) => {
  const mem = process.memoryUsage();

  res.json({
    ok: true,
    service: "wheel-mcp",
    version: APP_VERSION,
    uptimeSeconds: round(process.uptime(), 2),
    startedAt: SERVER_STARTED_AT.toISOString(),
    memory: {
      rssMB: round(mem.rss / 1024 / 1024, 2),
      heapTotalMB: round(mem.heapTotal / 1024 / 1024, 2),
      heapUsedMB: round(mem.heapUsed / 1024 / 1024, 2),
      externalMB: round(mem.external / 1024 / 1024, 2),
    },
    tools: Object.keys(tools),
  });
});

app.get("/tools", (_req, res) => {
  res.json({
    ok: true,
    tools: [
      { name: "get_quote", input: { symbol: "string" } },
      { name: "get_option_expirations", input: { symbol: "string" } },
      {
        name: "get_option_chain",
        input: { symbol: "string", expiration: "YYYY-MM-DD | optional" },
      },
      {
        name: "get_expected_move",
        input: { symbol: "string", expiration: "YYYY-MM-DD" },
      },
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
      {
        name: "get_technicals",
        input: {
          symbol: "string",
          range: "1mo | 3mo | 6mo | 1y | 2y | 5y | ytd | max | optional",
          interval: "1d | 1wk | 1mo | optional",
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

    const started = Date.now();
    const result = await handler(req.body || {});
    const durationMs = Date.now() - started;

    res.json({ ok: true, tool: toolName, durationMs, result });
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
    version: APP_VERSION,
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

  server.tool(
    "get_technicals",
    "Get technical indicators and trend context from historical prices.",
    {
      symbol: z.string().min(1),
      range: z.string().optional(),
      interval: z.string().optional(),
    },
    async ({ symbol, range, interval }) => {
      const result = await getTechnicalsTool({ symbol, range, interval });
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