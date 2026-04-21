import YahooFinance from "yahoo-finance2";

const yahooFinance = new YahooFinance({
  suppressNotices: ["yahooSurvey"],
});

const EXPIRATION = "2026-05-08";

const SOURCE_TICKERS = [
  "CF", "SNOW", "KO", "SLB", "TSCO", "PCG", "DOCU", "PATH", "F", "WBD",
  "BITX", "SOFI", "ABT", "SCHW", "CSX", "NDAQ", "BAC", "CVS", "GM", "HIMS",
  "UBER", "TGT", "AFRM", "SBUX", "NFLX", "TQQQ", "EXPE", "SHOP", "AAPL", "SOXL",
  "AMZN", "AMD", "ORCL", "PLTR", "NVDA", "MSFT", "GOOGL", "MU", "AVGO", "TSM",
  "MRVL", "IBKR", "DUOL", "RYAAY", "NEM", "DELL", "KMI", "HOOD", "LVS", "TW",
  "NI", "FSLR", "INCY", "NBIX", "ROOT", "VST", "TECK", "ZM", "PYPL", "DECK",
  "NVO", "PHM", "DXCM", "USB", "PDD"
];

const BARCHART_PERCENT = {
  NVO: 7.55,
  AAPL: 5.72,
  MSFT: 7.22,
  NVDA: 5.43,
  AMZN: 7.95,
  SOXL: 16.39,
  TQQQ: 8.94,
  HOOD: 12.06,
  AMD: 8.06,
};

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

function toNumber(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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

  if (midField > 0 && !hasBid && !hasAsk) return midField;
  if (lastPrice > 0) return lastPrice;
  if (midField > 0) return midField;
  if (hasBid) return bid;
  if (hasAsk) return ask;

  return 0;
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
  };
}

async function getOptionChain(symbol, expiration) {
  const chain = await yahooFinance.options(symbol, { date: expiration });
  const options = chain?.options?.[0] ?? {};

  const calls = Array.isArray(options.calls)
    ? options.calls.map((row) => ({
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
      }))
    : [];

  const puts = Array.isArray(options.puts)
    ? options.puts.map((row) => ({
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

function getAllStrikes(chain) {
  return [
    ...new Set(
      [...chain.calls, ...chain.puts]
        .map((x) => toNumber(x.strike))
        .filter(Boolean)
    ),
  ].sort((a, b) => a - b);
}

function getAtmStrike(strikes, price) {
  if (!strikes.length || !price) return null;

  return strikes.reduce((best, strike) => {
    if (best == null) return strike;
    return Math.abs(strike - price) < Math.abs(best - price) ? strike : best;
  }, null);
}

function getStraddleAtStrike(chain, strike) {
  const call = chain.calls.find((c) => toNumber(c.strike) === strike);
  const put = chain.puts.find((p) => toNumber(p.strike) === strike);

  const callMid = pickReliablePremium(call);
  const putMid = pickReliablePremium(put);

  if (!(callMid > 0) || !(putMid > 0)) {
    return null;
  }

  return {
    strike,
    callMid,
    putMid,
    total: callMid + putMid,
  };
}

function buildSymmetricStrangle(chain, strikes, atmIndex, offset) {
  const putIndex = atmIndex - offset;
  const callIndex = atmIndex + offset;

  if (putIndex < 0 || callIndex >= strikes.length) {
    return null;
  }

  const putStrike = strikes[putIndex];
  const callStrike = strikes[callIndex];

  const put = chain.puts.find((p) => toNumber(p.strike) === putStrike);
  const call = chain.calls.find((c) => toNumber(c.strike) === callStrike);

  const putMid = pickReliablePremium(put);
  const callMid = pickReliablePremium(call);

  if (!(putMid > 0) || !(callMid > 0)) {
    return null;
  }

  return {
    putStrike,
    callStrike,
    putMid,
    callMid,
    total: putMid + callMid,
  };
}

function getExpectedMoveYahooSimple(chain, spot) {
  const strikes = getAllStrikes(chain);
  const atmStrike = getAtmStrike(strikes, spot);
  if (!atmStrike) return null;

  const atm = getStraddleAtStrike(chain, atmStrike);
  if (!atm) return null;

  return {
    atmStrike,
    expectedMove: atm.total,
    expectedMovePct: spot > 0 ? (atm.total / spot) * 100 : null,
    atm,
  };
}

function getExpectedMoveWeighted(chain, spot) {
  const strikes = getAllStrikes(chain);
  const atmStrike = getAtmStrike(strikes, spot);
  if (!atmStrike) return null;

  const atmIndex = strikes.indexOf(atmStrike);
  const atm = getStraddleAtStrike(chain, atmStrike);
  if (!atm) return null;

  const s1 = buildSymmetricStrangle(chain, strikes, atmIndex, 1);
  const s2 = buildSymmetricStrangle(chain, strikes, atmIndex, 2);

  let weightedSum = 0;
  let weightUsed = 0;

  if (atm?.total > 0) {
    weightedSum += atm.total * 0.6;
    weightUsed += 0.6;
  }

  if (s1?.total > 0) {
    weightedSum += s1.total * 0.3;
    weightUsed += 0.3;
  }

  if (s2?.total > 0) {
    weightedSum += s2.total * 0.1;
    weightUsed += 0.1;
  }

  const expectedMove = weightUsed > 0 ? weightedSum / weightUsed : null;

  return {
    atmStrike,
    expectedMove,
    expectedMovePct: spot > 0 && expectedMove != null ? (expectedMove / spot) * 100 : null,
    atm,
    s1,
    s2,
    weightUsed,
  };
}

function getCandidateCalcs(weightedPct, yahooPct, atmPct, s1Pct, s2Pct) {
  const candidates = {};

  candidates.current_weighted = weightedPct ?? null;
  candidates.weighted_x_092 = weightedPct != null ? weightedPct * 0.92 : null;
  candidates.weighted_x_090 = weightedPct != null ? weightedPct * 0.90 : null;

  if (atmPct != null && s1Pct != null && s2Pct != null) {
    candidates.mix_70_20_10 = 0.7 * atmPct + 0.2 * s1Pct + 0.1 * s2Pct;
    candidates.mix_50_30_20 = 0.5 * atmPct + 0.3 * s1Pct + 0.2 * s2Pct;
    candidates.mix_55_30_15 = 0.55 * atmPct + 0.30 * s1Pct + 0.15 * s2Pct;
  } else {
    candidates.mix_70_20_10 = null;
    candidates.mix_50_30_20 = null;
    candidates.mix_55_30_15 = null;
  }

  candidates.yahoo_x_085 = yahooPct != null ? yahooPct * 0.85 : null;
  candidates.yahoo_x_080 = yahooPct != null ? yahooPct * 0.80 : null;

  return candidates;
}

function getBestCandidate(candidates, barchartPct) {
  if (barchartPct == null) return null;

  let bestName = null;
  let bestValue = null;
  let bestError = null;

  for (const [name, value] of Object.entries(candidates)) {
    if (value == null) continue;

    const errorAbs = Math.abs(value - barchartPct);

    if (bestError == null || errorAbs < bestError) {
      bestName = name;
      bestValue = value;
      bestError = errorAbs;
    }
  }

  return {
    bestName,
    bestValue: round(bestValue, 4),
    bestError: round(bestError, 4),
  };
}

async function analyzeTicker(symbol, expiration) {
  try {
    const [quote, chain] = await Promise.all([
      getQuote(symbol),
      getOptionChain(symbol, expiration),
    ]);

    const spot =
      toNumber(quote?.regularMarketPrice) ||
      toNumber(chain?.currentPrice);

    if (!spot) {
      return {
        symbol,
        ok: false,
        reason: "no_spot_price",
      };
    }

    const yahoo = getExpectedMoveYahooSimple(chain, spot);
    const weighted = getExpectedMoveWeighted(chain, spot);

    const atmPct =
      weighted?.atm?.total != null && spot > 0
        ? (weighted.atm.total / spot) * 100
        : null;

    const s1Pct =
      weighted?.s1?.total != null && spot > 0
        ? (weighted.s1.total / spot) * 100
        : null;

    const s2Pct =
      weighted?.s2?.total != null && spot > 0
        ? (weighted.s2.total / spot) * 100
        : null;

    const yahooPct = yahoo?.expectedMovePct ?? null;
    const weightedPct = weighted?.expectedMovePct ?? null;
    const barchartPct = BARCHART_PERCENT[symbol] ?? null;

    const candidates = getCandidateCalcs(
      yahooPct != null && weightedPct == null ? yahooPct : weightedPct,
      yahooPct,
      atmPct,
      s1Pct,
      s2Pct
    );

    const bestCandidate = getBestCandidate(candidates, barchartPct);

    return {
      symbol,
      expiration,
      ok: true,
      spot: round(spot, 3),
      yahooEM: round(yahoo?.expectedMove, 3),
      yahooPct: round(yahooPct, 4),
      weightedEM: round(weighted?.expectedMove, 3),
      weightedPct: round(weightedPct, 4),
      atmPct: round(atmPct, 4),
      s1Pct: round(s1Pct, 4),
      s2Pct: round(s2Pct, 4),
      barchartPct: barchartPct != null ? round(barchartPct, 4) : null,
      errorYahooVsBarchart:
        barchartPct != null && yahooPct != null ? round(yahooPct - barchartPct, 4) : null,
      errorWeightedVsBarchart:
        barchartPct != null && weightedPct != null ? round(weightedPct - barchartPct, 4) : null,
      candidates: Object.fromEntries(
        Object.entries(candidates).map(([k, v]) => [k, round(v, 4)])
      ),
      bestCandidate,
    };
  } catch (error) {
    return {
      symbol,
      expiration,
      ok: false,
      reason: error.message || "analyze_failed",
    };
  }
}

function printMainTable(results) {
  const rows = results.map((r) => ({
    Symbol: r.symbol,
    Spot: r.spot ?? "—",
    YahooPct: r.yahooPct != null ? `${r.yahooPct.toFixed(2)}%` : "—",
    WeightedPct: r.weightedPct != null ? `${r.weightedPct.toFixed(2)}%` : "—",
    BarchartPct: r.barchartPct != null ? `${r.barchartPct.toFixed(2)}%` : "—",
    YahooErr: r.errorYahooVsBarchart != null ? `${r.errorYahooVsBarchart.toFixed(2)}` : "—",
    WeightedErr: r.errorWeightedVsBarchart != null ? `${r.errorWeightedVsBarchart.toFixed(2)}` : "—",
    Best: r.bestCandidate?.bestName ?? "—",
    BestErr: r.bestCandidate?.bestError != null ? r.bestCandidate.bestError.toFixed(2) : "—",
  }));

  console.table(rows);
}

function printCandidateSummary(results) {
  const stats = {};

  for (const row of results) {
    if (!row.ok || row.barchartPct == null || !row.candidates) continue;

    for (const [name, value] of Object.entries(row.candidates)) {
      if (value == null) continue;

      const error = Math.abs(value - row.barchartPct);

      if (!stats[name]) {
        stats[name] = {
          count: 0,
          totalError: 0,
          maxError: 0,
        };
      }

      stats[name].count += 1;
      stats[name].totalError += error;
      stats[name].maxError = Math.max(stats[name].maxError, error);
    }
  }

  const summaryRows = Object.entries(stats)
    .map(([name, s]) => ({
      Formula: name,
      Count: s.count,
      AvgAbsError: round(s.totalError / s.count, 4),
      MaxError: round(s.maxError, 4),
    }))
    .sort((a, b) => a.AvgAbsError - b.AvgAbsError);

  console.table(summaryRows);
}

async function main() {
  console.log(`Analyse expected move v2 sur ${SOURCE_TICKERS.length} tickers`);
  console.log(`Expiration: ${EXPIRATION}`);
  console.log("");

  const results = [];

  for (const symbol of SOURCE_TICKERS) {
    const result = await analyzeTicker(symbol, EXPIRATION);
    results.push(result);

    if (!result.ok) {
      console.log(`${symbol.padEnd(6)} | ERROR | ${result.reason}`);
      continue;
    }

    console.log(
      `${symbol.padEnd(6)} | Yahoo ${String(result.yahooPct ?? "—").padStart(6)}% | Weighted ${String(result.weightedPct ?? "—").padStart(6)}% | Barchart ${String(result.barchartPct ?? "—").padStart(6)}% | Best ${result.bestCandidate?.bestName ?? "—"}`
    );
  }

  console.log("\n=== TABLEAU PRINCIPAL ===");
  printMainTable(results);

  console.log("\n=== RÉSUMÉ FORMULES CANDIDATES ===");
  printCandidateSummary(results);

  console.log("\n=== JSON COMPLET ===");
  console.log(JSON.stringify(results, null, 2));
}

main().catch((error) => {
  console.error("Erreur analyze-list.js:", error);
  process.exit(1);
});