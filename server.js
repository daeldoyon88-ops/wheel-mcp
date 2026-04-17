import express from "express";
import cors from "cors";
import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance();

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const WEEKLY_TARGET_PCT = 0.5;
const SAFE_STRIKE_FLOOR_RATIO = 0.85;
const MAX_SCAN_TICKERS = 200;

// Liquidité / exécution
const MIN_VOLUME = 50;
const MIN_OPEN_INTEREST = 100;
const MAX_SPREAD_PCT = 0.25; // 25%

const EARNINGS_SYMBOLS = new Set(["NFLX"]);

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

function toNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function minPremiumForSpot(spot, dteDays) {
  if (!spot || spot <= 0 || !dteDays || dteDays <= 0) return 0;
  return spot * (WEEKLY_TARGET_PCT / 100) * (dteDays / 7);
}

function weeklyYieldDecimal(mid, strike, dteDays) {
  if (!mid || !strike || !dteDays) return 0;
  return (mid / strike) * (7 / dteDays);
}

function strikeDistancePct(strike, spot) {
  if (!strike || !spot || spot <= 0) return 0;
  return ((strike - spot) / spot) * 100;
}

function getDteDays(expiration) {
  const now = new Date();
  const exp = new Date(`${expiration}T00:00:00`);
  const diff = exp - now;
  return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)));
}

function pickReliablePremium(row) {
  const midField = toNumber(row?.mid);
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  const lastPrice = toNumber(row?.lastPrice);

  const hasBid = bid > 0;
  const hasAsk = ask > 0;
  const bidAskMid = hasBid && hasAsk ? (bid + ask) / 2 : 0;

  if (hasBid && hasAsk) {
    if (midField > 0) {
      const spread = Math.abs(midField - bidAskMid);
      const tolerance = Math.max(0.03, bidAskMid * 0.35);
      if (spread <= tolerance) return midField;
    }
    return bidAskMid;
  }

  if (midField > 0 && !hasBid && !hasAsk) {
    return midField;
  }

  if (midField > 0 && hasAsk && !hasBid) {
    if (midField <= ask * 1.15) return midField;
  }

  if (midField > 0 && hasBid && !hasAsk) {
    if (midField >= bid * 0.85) return midField;
  }

  if (lastPrice > 0) return lastPrice;
  if (midField > 0) return midField;
  if (hasBid) return bid;
  if (hasAsk) return ask;

  return 0;
}

function normalizePutForSelection(put, spot, targetPremium) {
  const strike = toNumber(put?.strike);
  const premium = pickReliablePremium(put);

  return {
    strike,
    bid: toNumber(put?.bid),
    ask: toNumber(put?.ask),
    lastPrice: toNumber(put?.lastPrice),
    mid: premium,
    volume: toNumber(put?.volume),
    openInterest: toNumber(put?.openInterest),
    impliedVolatility: toNumber(put?.impliedVolatility),
    targetPremium,
    qualifiesTarget: premium >= targetPremium,
    distanceToTarget: Math.abs(premium - targetPremium),
    distancePct: strikeDistancePct(strike, spot),
  };
}

function enrichLiquidity(row) {
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  const mid = toNumber(row?.mid);
  const volume = toNumber(row?.volume);
  const openInterest = toNumber(row?.openInterest);

  const spread = bid > 0 && ask > 0 ? ask - bid : 0;

  // Si pas de mid fiable, spreadPct doit être considéré mauvais
  const spreadPct = mid > 0 ? spread / mid : 1;

  // On considère liquide uniquement si :
  // - bid/ask présents
  // - spread raisonnable
  // - volume minimal
  // - OI minimal
  const isLiquid =
    bid > 0 &&
    ask > 0 &&
    mid > 0 &&
    spreadPct <= MAX_SPREAD_PCT &&
    volume >= MIN_VOLUME &&
    openInterest >= MIN_OPEN_INTEREST;

  return {
    ...row,
    spread,
    spreadPct,
    isLiquid,
  };
}

function selectPutStrikes({ puts, spot, lowerBoundForSelection, dteDays }) {
  const targetPremium = minPremiumForSpot(spot, dteDays);

  const eligible = (puts || [])
    .map((put) => normalizePutForSelection(put, spot, targetPremium))
    .map((put) => enrichLiquidity(put))
    .filter((put) => put.strike > 0)
    .filter((put) => put.strike < lowerBoundForSelection)
    .filter((put) => put.mid > 0)
    .sort((a, b) => a.strike - b.strike);

  const aggressiveStrike =
    eligible.length > 0
      ? [...eligible].sort((a, b) => b.strike - a.strike)[0]
      : null;

  const safeStrikeFloor = lowerBoundForSelection * SAFE_STRIKE_FLOOR_RATIO;

  const safeZone = eligible.filter((put) => put.strike >= safeStrikeFloor);

  // On privilégie les strikes liquides pour le SAFE
  const liquidSafeZone = safeZone.filter((put) => put.isLiquid);

  // Fallback propre : si aucun strike liquide, on garde l’ancienne logique
  const safeSelectionPool =
    liquidSafeZone.length > 0 ? liquidSafeZone : safeZone;

  const safeCandidates = safeSelectionPool
    .filter((put) => put.mid >= targetPremium)
    .sort((a, b) => {
      const diff = a.distanceToTarget - b.distanceToTarget;
      if (diff !== 0) return diff;
      return b.strike - a.strike;
    });

  const safeStrike = safeCandidates.length > 0 ? safeCandidates[0] : null;

  return {
    targetPremium,
    eligible,
    safeZone,
    liquidSafeZone,
    safeCandidates,
    safeStrike,
    aggressiveStrike,
    safeStrikeFloor,
  };
}

async function getQuote(symbol) {
  const quote = await yahooFinance.quote(symbol);
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
  };
}

async function getOptionExpirations(symbol) {
  const chain = await yahooFinance.options(symbol);
  const dates = Array.isArray(chain?.expirationDates)
    ? chain.expirationDates.map((d) => {
        const dt = new Date(d);
        return dt.toISOString().slice(0, 10);
      })
    : [];

  return {
    symbol,
    availableExpirations: dates,
  };
}

async function getOptionChain(symbol, expiration) {
  const chain = await yahooFinance.options(symbol, { date: expiration });
  const options = chain?.options?.[0] ?? {};

  const calls = Array.isArray(options.calls)
    ? options.calls.map((row) => ({
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
      }))
    : [];

  const puts = Array.isArray(options.puts)
    ? options.puts.map((row) => ({
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
      }))
    : [];

  return {
    symbol,
    currentPrice:
      chain?.quote?.regularMarketPrice ??
      chain?.quote?.postMarketPrice ??
      chain?.quote?.preMarketPrice ??
      null,
    expiration,
    calls,
    puts,
  };
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
    };
  }

  const allStrikes = [...new Set(
    [...chain.calls, ...chain.puts]
      .map((x) => toNumber(x.strike))
      .filter(Boolean)
  )];

  if (!allStrikes.length) {
    return {
      symbol,
      expiration,
      expectedMove: null,
      expectedMovePercent: null,
      oneSigmaRange: null,
    };
  }

  const atmStrike = allStrikes.reduce((best, strike) => {
    if (best == null) return strike;
    return Math.abs(strike - price) < Math.abs(best - price) ? strike : best;
  }, null);

  const call = chain.calls.find((c) => toNumber(c.strike) === atmStrike);
  const put = chain.puts.find((p) => toNumber(p.strike) === atmStrike);

  const callMid = pickReliablePremium(call);
  const putMid = pickReliablePremium(put);
  const expectedMove = callMid + putMid;
  const expectedMovePercent = price > 0 ? (expectedMove / price) * 100 : null;

  return {
    symbol,
    expiration,
    currentPrice: price,
    atmStrike,
    expectedMove: round(expectedMove, 4),
    expectedMovePercent: round(expectedMovePercent, 4),
    oneSigmaRange: {
      lower: round(price - expectedMove, 4),
      upper: round(price + expectedMove, 4),
    },
  };
}

async function getTechnicals(symbol) {
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: new Date(Date.now() - 1000 * 60 * 60 * 24 * 120),
      interval: "1d",
    });

    const quotes = result?.quotes ?? [];
    const closes = quotes
      .map((q) => toNumber(q?.close))
      .filter((v) => v > 0);

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

    function sma(values, period) {
      if (values.length < period) return null;
      const slice = values.slice(-period);
      const sum = slice.reduce((acc, val) => acc + val, 0);
      return sum / period;
    }

    function computeRSI(values, period = 14) {
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

        avgGain = ((avgGain * (period - 1)) + gain) / period;
        avgLoss = ((avgLoss * (period - 1)) + loss) / period;
      }

      if (avgLoss === 0) return 100;
      const rs = avgGain / avgLoss;
      return 100 - (100 / (1 + rs));
    }

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
    const result = await yahooFinance.chart(symbol, {
      period1: new Date(Date.now() - 1000 * 60 * 60 * 24 * 180),
      interval: "1d",
    });

    const quotes = result?.quotes ?? [];
    const rows = quotes
      .map((q) => ({
        high: toNumber(q?.high),
        low: toNumber(q?.low),
        close: toNumber(q?.close),
      }))
      .filter((q) => q.high > 0 && q.low > 0 && q.close > 0);

    if (rows.length < 20) {
      return {
        symbol,
        support: null,
        resistance: null,
      };
    }

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
    return {
      symbol,
      support: null,
      resistance: null,
      currentPrice: null,
    };
  }
}

async function scanTicker(symbol, expiration) {
  const expirations = await getOptionExpirations(symbol);
  if (!expirations.availableExpirations.includes(expiration)) {
    return {
      symbol,
      ok: false,
      reason: "expiration_not_available",
    };
  }

  const [quote, expectedMove, optionChain, technicals, supportResistance] = await Promise.all([
    getQuote(symbol),
    getExpectedMove(symbol, expiration),
    getOptionChain(symbol, expiration),
    getTechnicals(symbol),
    getSupportResistance(symbol),
  ]);

  const spot =
    toNumber(quote?.regularMarketPrice) ||
    toNumber(optionChain?.currentPrice) ||
    toNumber(expectedMove?.currentPrice);

  if (!spot) {
    return {
      symbol,
      ok: false,
      reason: "no_spot_price",
    };
  }

  const expectedMoveAbs = toNumber(expectedMove?.expectedMove);
  const hasEarnings = EARNINGS_SYMBOLS.has(symbol);
  const adjustedMove = hasEarnings ? expectedMoveAbs * 2 : expectedMoveAbs;
  const lowerBound = spot - adjustedMove;

  if (!lowerBound || lowerBound <= 0) {
    return {
      symbol,
      ok: false,
      reason: "invalid_lower_bound",
    };
  }

  const dteDays = getDteDays(expiration);
  const puts = Array.isArray(optionChain?.puts) ? optionChain.puts : [];

  const strikeSelection = selectPutStrikes({
    puts,
    spot,
    lowerBoundForSelection: lowerBound,
    dteDays,
  });

  function buildStrike(row) {
    if (!row) return null;
    const premium = toNumber(row.mid);
    const weeklyYield = weeklyYieldDecimal(premium, row.strike, dteDays);

    return {
      strike: row.strike,
      premium: round(premium, 3),
      weeklyYield: round(weeklyYield, 4),
      annualizedYield: round(weeklyYield * 52, 4),
      distancePct: round(Math.abs(row.distancePct) / 100, 4),
      volume: row.volume,
      openInterest: row.openInterest,
      bid: round(row.bid, 3),
      ask: round(row.ask, 3),
      spread: round(row.spread, 3),
      spreadPct: round(row.spreadPct, 4),
      isLiquid: !!row.isLiquid,
    };
  }

  const safeStrike = buildStrike(strikeSelection.safeStrike);
  const aggressiveStrike = buildStrike(strikeSelection.aggressiveStrike);
  const targetPremium = strikeSelection.targetPremium;

  const support = toNumber(supportResistance?.support) || null;
  const resistance = toNumber(supportResistance?.resistance) || null;

  const strikeVsSupportPct =
    safeStrike && support && support > 0
      ? ((safeStrike.strike - support) / support) * 100
      : null;

  const strikeVsResistancePct =
    safeStrike && resistance && resistance > 0
      ? ((resistance - safeStrike.strike) / resistance) * 100
      : null;

  let supportStatus = "unknown";
  if (strikeVsSupportPct != null) {
    if (strikeVsSupportPct >= 2) supportStatus = "room_above_support";
    else if (strikeVsSupportPct >= 0) supportStatus = "near_support";
    else supportStatus = "below_support";
  }

  const passesFilter =
    !!safeStrike &&
    (safeStrike.premium ?? 0) >= targetPremium &&
    (safeStrike.annualizedYield ?? 0) >= 0.26;

  return {
    symbol,
    ok: true,
    expiration,
    hasEarnings,
    currentPrice: round(spot, 3),
    expectedMove: round(expectedMoveAbs, 3),
    adjustedMove: round(adjustedMove, 3),
    lowerBound: round(lowerBound, 3),
    dteDays,
    targetPremium: round(targetPremium, 3),
    safeStrike,
    maxPremiumStrike: aggressiveStrike,
    technicals: {
      rsi: technicals?.rsi ?? null,
      trend: technicals?.trend ?? "unknown",
      momentum: technicals?.momentum ?? "unknown",
      sma20: technicals?.sma20 ?? null,
      sma50: technicals?.sma50 ?? null,
    },
    supportResistance: {
      support: supportResistance?.support ?? null,
      resistance: supportResistance?.resistance ?? null,
      strikeVsSupportPct: strikeVsSupportPct != null ? round(strikeVsSupportPct, 2) : null,
      strikeVsResistancePct: strikeVsResistancePct != null ? round(strikeVsResistancePct, 2) : null,
      supportStatus,
    },
    passesFilter,
    debug: {
      eligibleCount: strikeSelection.eligible.length,
      safeZoneCount: strikeSelection.safeZone.length,
      liquidSafeZoneCount: strikeSelection.liquidSafeZone.length,
      safeCandidatesCount: strikeSelection.safeCandidates.length,
      safeStrikeFloor: round(strikeSelection.safeStrikeFloor, 3),
      usedLiquidityFilter: strikeSelection.liquidSafeZone.length > 0,
      reasonKept: passesFilter ? "passes_filters" : "filtered_out",
    },
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "wheel-mcp-backend" });
});

app.get("/tools", (_req, res) => {
  res.json({
    ok: true,
    tools: [
      "get_quote",
      "get_option_expirations",
      "get_expected_move",
      "get_option_chain",
      "get_technicals",
      "get_support_resistance",
      "scan_shortlist",
    ],
  });
});

app.post("/tools/get_quote", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await getQuote(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_quote failed" });
  }
});

app.post("/tools/get_option_expirations", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await getOptionExpirations(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_option_expirations failed" });
  }
});

app.post("/tools/get_option_chain", async (req, res) => {
  try {
    const { symbol, expiration } = req.body;
    const result = await getOptionChain(symbol, expiration);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_option_chain failed" });
  }
});

app.post("/tools/get_expected_move", async (req, res) => {
  try {
    const { symbol, expiration } = req.body;
    const result = await getExpectedMove(symbol, expiration);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_expected_move failed" });
  }
});

app.post("/tools/get_technicals", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await getTechnicals(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_technicals failed" });
  }
});

app.post("/tools/get_support_resistance", async (req, res) => {
  try {
    const { symbol } = req.body;
    const result = await getSupportResistance(symbol);
    res.json({ ok: true, result });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "get_support_resistance failed" });
  }
});

app.post("/scan_shortlist", async (req, res) => {
  try {
    const {
      expiration,
      tickers = [],
      topN = 20,
    } = req.body ?? {};

    if (!expiration) {
      return res.status(400).json({ ok: false, error: "expiration is required" });
    }

    if (!Array.isArray(tickers) || tickers.length === 0) {
      return res.status(400).json({ ok: false, error: "tickers must be a non-empty array" });
    }

    if (tickers.length > MAX_SCAN_TICKERS) {
      return res.status(400).json({
        ok: false,
        error: `max ${MAX_SCAN_TICKERS} tickers per scan`,
      });
    }

    const cleanedTickers = [...new Set(
      tickers
        .map((t) => String(t || "").trim().toUpperCase())
        .filter(Boolean)
    )];

    const shortlist = [];
    const rejected = [];
    const errors = [];

    const BATCH_SIZE = 8;

    for (let i = 0; i < cleanedTickers.length; i += BATCH_SIZE) {
      const batch = cleanedTickers.slice(i, i + BATCH_SIZE);

      const batchResults = await Promise.allSettled(
        batch.map((symbol) => scanTicker(symbol, expiration))
      );

      for (let j = 0; j < batchResults.length; j += 1) {
        const result = batchResults[j];
        const symbol = batch[j];

        if (result.status === "fulfilled") {
          const item = result.value;

          if (!item?.ok) {
            rejected.push({
              symbol,
              reason: item?.reason || "not_ok",
            });
            continue;
          }

          if (item.passesFilter) {
            shortlist.push(item);
          } else {
            rejected.push({
              symbol,
              reason: item?.debug?.reasonKept || "filtered_out",
              targetPremium: item?.targetPremium ?? null,
              safeStrike: item?.safeStrike ?? null,
              aggressiveStrike: item?.maxPremiumStrike ?? null,
            });
          }
        } else {
          errors.push({
            symbol,
            error: result.reason?.message || "scan_failed",
          });
        }
      }
    }

    shortlist.sort((a, b) => {
      const ay = toNumber(a?.safeStrike?.annualizedYield);
      const by = toNumber(b?.safeStrike?.annualizedYield);
      return by - ay;
    });

    return res.json({
      ok: true,
      expiration,
      scanned: cleanedTickers.length,
      kept: shortlist.length,
      returned: Math.min(topN, shortlist.length),
      shortlist: shortlist.slice(0, topN),
      rejected,
      errors,
    });
  } catch (error) {
    return res.status(500).json({
      ok: false,
      error: error.message || "scan_shortlist failed",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Wheel backend listening on port ${PORT}`);
});