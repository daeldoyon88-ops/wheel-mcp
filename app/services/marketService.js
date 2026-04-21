import {
  computeAbsoluteSpread,
  evaluateLiquidity,
  evaluateTradability,
  getConservativePremium,
  pickReliablePremium,
} from "../calculations/wheelMetrics.js";
import { round, toNumber } from "../utils/number.js";

export function createMarketService(provider) {
  async function getQuote(symbol) {
    const quote = await provider.getQuote(symbol);
    return {
      symbol,
      regularMarketPrice:
        quote?.regularMarketPrice ??
        quote?.postMarketPrice ??
        quote?.preMarketPrice ??
        quote?.regularMarketPreviousClose ??
        null,
      shortName: quote?.shortName ?? symbol,
      currency: quote?.currency ?? "USD",
      regularMarketVolume: toNumber(quote?.regularMarketVolume) || null,
      averageDailyVolume3Month: toNumber(quote?.averageDailyVolume3Month) || null,
      averageDailyVolume10Day: toNumber(quote?.averageDailyVolume10Day) || null,
    };
  }

  async function getOptionExpirations(symbol) {
    const chain = await provider.getOptions(symbol);
    const dates = Array.isArray(chain?.expirationDates)
      ? chain.expirationDates.map((d) => new Date(d).toISOString().slice(0, 10))
      : [];
    return { symbol, availableExpirations: dates };
  }

  async function getOptionChain(symbol, expiration) {
    const chain = await provider.getOptions(symbol, { date: expiration });
    const options = chain?.options?.[0] ?? {};

    const mapOptionRow = (row) => ({
      contractSymbol: row.contractSymbol,
      strike: row.strike,
      lastPrice: row.lastPrice,
      bid: row.bid,
      ask: row.ask,
      mid:
        row.bid != null && row.ask != null
          ? (Number(row.bid) + Number(row.ask)) / 2
          : row.lastPrice ?? null,
      volume: row.volume,
      openInterest: row.openInterest,
      impliedVolatility: row.impliedVolatility,
      inTheMoney: row.inTheMoney,
      expiration,
    });

    return {
      symbol,
      currentPrice:
        chain?.quote?.regularMarketPrice ??
        chain?.quote?.postMarketPrice ??
        chain?.quote?.preMarketPrice ??
        null,
      expiration,
      calls: Array.isArray(options.calls) ? options.calls.map(mapOptionRow) : [],
      puts: Array.isArray(options.puts) ? options.puts.map(mapOptionRow) : [],
    };
  }

  function buildSymmetricStrangleFromOffsets(chain, strikes, atmIndex, offset) {
    const putIndex = atmIndex - offset;
    const callIndex = atmIndex + offset;
    if (putIndex < 0 || callIndex >= strikes.length) return null;

    const putStrike = strikes[putIndex];
    const callStrike = strikes[callIndex];
    const put = chain.puts.find((p) => toNumber(p.strike) === putStrike);
    const call = chain.calls.find((c) => toNumber(c.strike) === callStrike);
    const putMid = pickReliablePremium(put);
    const callMid = pickReliablePremium(call);
    if (!(putMid > 0) || !(callMid > 0)) return null;

    return { offset, putStrike, callStrike, putMid, callMid, totalPremium: putMid + callMid };
  }

  async function getExpectedMove(symbol, expiration) {
    const chain = await getOptionChain(symbol, expiration);
    const price = toNumber(chain?.currentPrice);

    if (!price || !Array.isArray(chain.calls) || !Array.isArray(chain.puts)) {
      return {
        symbol,
        expiration,
        expectedMove: null,
        expectedMovePercent: null,
        oneSigmaRange: null,
        method: "weighted_60_30_10",
        components: null,
      };
    }

    const allStrikes = [
      ...new Set(
        [...chain.calls, ...chain.puts]
          .map((x) => toNumber(x.strike))
          .filter(Boolean)
      ),
    ].sort((a, b) => a - b);

    if (!allStrikes.length) {
      return {
        symbol,
        expiration,
        expectedMove: null,
        expectedMovePercent: null,
        oneSigmaRange: null,
        method: "weighted_60_30_10",
        components: null,
      };
    }

    const atmStrike = allStrikes.reduce((best, strike) => {
      if (best == null) return strike;
      return Math.abs(strike - price) < Math.abs(best - price) ? strike : best;
    }, null);
    const atmIndex = allStrikes.indexOf(atmStrike);
    const atmCall = chain.calls.find((c) => toNumber(c.strike) === atmStrike);
    const atmPut = chain.puts.find((p) => toNumber(p.strike) === atmStrike);
    const atmCallMid = pickReliablePremium(atmCall);
    const atmPutMid = pickReliablePremium(atmPut);
    const atmStraddle = atmCallMid + atmPutMid;
    const strangle1 = buildSymmetricStrangleFromOffsets(chain, allStrikes, atmIndex, 1);
    const strangle2 = buildSymmetricStrangleFromOffsets(chain, allStrikes, atmIndex, 2);

    const hasAtm = atmStraddle > 0;
    const hasStrangle1 = !!(strangle1?.totalPremium > 0);
    const hasStrangle2 = !!(strangle2?.totalPremium > 0);
    const canUseWeightedFormula = hasAtm && hasStrangle1 && hasStrangle2;

    const expectedMove = canUseWeightedFormula
      ? atmStraddle * 0.6 + strangle1.totalPremium * 0.3 + strangle2.totalPremium * 0.1
      : hasAtm
        ? atmStraddle
        : null;
    const expectedMovePercent =
      price > 0 && expectedMove != null ? (expectedMove / price) * 100 : null;

    return {
      symbol,
      expiration,
      currentPrice: price,
      atmStrike,
      method: "weighted_60_30_10",
      expectedMove: round(expectedMove, 4),
      expectedMovePercent: round(expectedMovePercent, 4),
      oneSigmaRange:
        expectedMove != null
          ? { lower: round(price - expectedMove, 4), upper: round(price + expectedMove, 4) }
          : null,
      components: {
        atmStraddle: {
          strike: atmStrike,
          callMid: round(atmCallMid, 4),
          putMid: round(atmPutMid, 4),
          totalPremium: round(atmStraddle, 4),
          weight: 0.6,
          used: atmStraddle > 0,
        },
        strangle1: strangle1
          ? {
              putStrike: strangle1.putStrike,
              callStrike: strangle1.callStrike,
              putMid: round(strangle1.putMid, 4),
              callMid: round(strangle1.callMid, 4),
              totalPremium: round(strangle1.totalPremium, 4),
              weight: 0.3,
              used: true,
            }
          : {
              putStrike: null,
              callStrike: null,
              putMid: null,
              callMid: null,
              totalPremium: null,
              weight: 0.3,
              used: false,
            },
        strangle2: strangle2
          ? {
              putStrike: strangle2.putStrike,
              callStrike: strangle2.callStrike,
              putMid: round(strangle2.putMid, 4),
              callMid: round(strangle2.callMid, 4),
              totalPremium: round(strangle2.totalPremium, 4),
              weight: 0.1,
              used: true,
            }
          : {
              putStrike: null,
              callStrike: null,
              putMid: null,
              callMid: null,
              totalPremium: null,
              weight: 0.1,
              used: false,
            },
        weightUsed: canUseWeightedFormula ? 1 : hasAtm ? 0.6 : 0,
        fallbackUsed: !canUseWeightedFormula,
      },
    };
  }

  async function getTechnicals(symbol) {
    try {
      const result = await provider.getChart(symbol, {
        period1: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120),
        interval: "1d",
      });
      const quotes = result?.quotes ?? [];
      const closes = quotes.map((q) => toNumber(q?.close)).filter((v) => v > 0);
      if (closes.length < 50) {
        return {
          symbol,
          rsi: null,
          trend: "unknown",
          momentum: "unknown",
          sma20: null,
          sma50: null,
          currentPrice: closes.length ? round(closes[closes.length - 1], 3) : null,
        };
      }

      const currentPrice = closes[closes.length - 1];
      const sma = (values, period) =>
        values.length < period
          ? null
          : values.slice(-period).reduce((acc, val) => acc + val, 0) / period;

      const computeRSI = (values, period = 14) => {
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
      };

      const sma20 = sma(closes, 20);
      const sma50 = sma(closes, 50);
      const rsi = computeRSI(closes, 14);
      let trend = "neutral";
      if (sma20 != null && sma50 != null) {
        if (currentPrice > sma20 && sma20 > sma50) trend = "bullish";
        else if (currentPrice < sma20 && sma20 < sma50) trend = "bearish";
      }
      let momentum = "neutral";
      if (rsi != null) {
        if (rsi >= 60) momentum = "positive";
        else if (rsi <= 40) momentum = "negative";
      }

      return {
        symbol,
        rsi: round(rsi, 2),
        trend,
        momentum,
        sma20: round(sma20, 3),
        sma50: round(sma50, 3),
        currentPrice: round(currentPrice, 3),
      };
    } catch (_error) {
      return {
        symbol,
        rsi: null,
        trend: "unknown",
        momentum: "unknown",
        sma20: null,
        sma50: null,
        currentPrice: null,
      };
    }
  }

  async function getSupportResistance(symbol) {
    try {
      const result = await provider.getChart(symbol, {
        period1: new Date(Date.now() - 1000 * 60 * 60 * 24 * 180),
        interval: "1d",
      });
      const rows = (result?.quotes ?? [])
        .map((q) => ({ high: toNumber(q?.high), low: toNumber(q?.low), close: toNumber(q?.close) }))
        .filter((q) => q.high > 0 && q.low > 0 && q.close > 0);
      if (rows.length < 20) return { symbol, support: null, resistance: null };

      const recent = rows.slice(-40);
      const currentPrice = recent[recent.length - 1]?.close ?? null;
      const lows = recent.map((r) => r.low).sort((a, b) => a - b);
      const highs = recent.map((r) => r.high).sort((a, b) => b - a);
      const support = lows[Math.floor(lows.length * 0.2)] ?? null;
      const resistance = highs[Math.floor(highs.length * 0.2)] ?? null;

      return {
        symbol,
        support: support ? round(support, 3) : null,
        resistance: resistance ? round(resistance, 3) : null,
        currentPrice: currentPrice ? round(currentPrice, 3) : null,
      };
    } catch (_error) {
      return { symbol, support: null, resistance: null, currentPrice: null };
    }
  }

  async function getBestStrike(
    symbol,
    expiration,
    optionType = "call",
    targetPrice = null,
    percentOtm = null
  ) {
    const chain = await getOptionChain(symbol, expiration);
    const currentPrice = toNumber(chain?.currentPrice);
    const list = optionType === "put" ? chain.puts : chain.calls;
    if (!Array.isArray(list) || !list.length) {
      return { symbol, expiration, optionType, currentPrice, bestStrike: null };
    }

    const normalized = list
      .map((row) => ({
        strike: toNumber(row?.strike),
        bid: toNumber(row?.bid),
        ask: toNumber(row?.ask),
        lastPrice: toNumber(row?.lastPrice),
        mid: pickReliablePremium(row),
        conservativePremium: getConservativePremium(row),
        tradability: evaluateTradability(row),
        liquidity: evaluateLiquidity(row),
        volume: toNumber(row?.volume),
        openInterest: toNumber(row?.openInterest),
      }))
      .filter((row) => row.strike > 0);

    let targetStrike = null;
    if (targetPrice != null) targetStrike = Number(targetPrice);
    else if (percentOtm != null && currentPrice > 0) {
      targetStrike =
        optionType === "put"
          ? currentPrice * (1 - percentOtm / 100)
          : currentPrice * (1 + percentOtm / 100);
    }

    const best =
      targetStrike == null
        ? normalized[0] ?? null
        : normalized.sort(
            (a, b) => Math.abs(a.strike - targetStrike) - Math.abs(b.strike - targetStrike)
          )[0] ?? null;

    return {
      symbol,
      expiration,
      optionType,
      currentPrice: round(currentPrice, 3),
      targetStrike: targetStrike != null ? round(targetStrike, 3) : null,
      bestStrike: best
        ? {
            strike: best.strike,
            bid: round(best.bid, 3),
            ask: round(best.ask, 3),
            lastPrice: round(best.lastPrice, 3),
            mid: round(best.mid, 3),
            conservativePremium: round(best.conservativePremium, 3),
            tradability: best.tradability,
            liquidity: best.liquidity,
            volume: best.volume,
            openInterest: best.openInterest,
          }
        : null,
    };
  }

  async function analyzeTradeSetup(symbol, expiration, optionType = "put", strike) {
    const [quote, expectedMove, technicals, supportResistance] = await Promise.all([
      getQuote(symbol),
      getExpectedMove(symbol, expiration),
      getTechnicals(symbol),
      getSupportResistance(symbol),
    ]);
    const currentPrice =
      toNumber(quote?.regularMarketPrice) || toNumber(expectedMove?.currentPrice);
    const strikeNumber = toNumber(strike);
    const strikeVsSupportPct =
      supportResistance?.support && strikeNumber > 0
        ? ((strikeNumber - supportResistance.support) / supportResistance.support) * 100
        : null;

    let verdict = "neutral";
    if (optionType === "put") {
      if (
        technicals?.trend === "bullish" &&
        (technicals?.momentum === "positive" || technicals?.momentum === "neutral") &&
        strikeVsSupportPct != null &&
        strikeVsSupportPct >= 0
      ) verdict = "constructive";
      else if (strikeVsSupportPct != null && strikeVsSupportPct < 0) verdict = "caution";
    }

    return {
      symbol,
      expiration,
      optionType,
      strike: strikeNumber,
      currentPrice: round(currentPrice, 3),
      expectedMove: expectedMove?.expectedMove ?? null,
      expectedMovePercent: expectedMove?.expectedMovePercent ?? null,
      expectedMoveMethod: expectedMove?.method ?? null,
      technicals,
      supportResistance: {
        ...supportResistance,
        strikeVsSupportPct: strikeVsSupportPct != null ? round(strikeVsSupportPct, 2) : null,
      },
      verdict,
    };
  }

  return {
    getQuote,
    getOptionExpirations,
    getOptionChain,
    getExpectedMove,
    getTechnicals,
    getSupportResistance,
    getBestStrike,
    analyzeTradeSetup,
  };
}
