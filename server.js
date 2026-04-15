import YahooFinance from "yahoo-finance2";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const yahooFinance = new YahooFinance();

const server = new McpServer({
  name: "wheel-mcp",
  version: "1.0.0",
});

function toISODateOnly(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return d.toISOString().slice(0, 10);
}

function normalizeExpirationInput(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid expiration: ${value}`);
  }
  return d;
}

function daysToExpiration(expiration) {
  const now = new Date();
  const exp = expiration instanceof Date ? expiration : new Date(expiration);
  const ms = exp.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86400000));
}

function yearFractionFromNow(expiration) {
  const dte = daysToExpiration(expiration);
  return Math.max(dte / 365, 1 / 365);
}

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function midFromBidAskOrLast(bid, ask, lastPrice = null) {
  const b = safeNumber(bid);
  const a = safeNumber(ask);
  const l = safeNumber(lastPrice);

  if (b != null && a != null && a >= b && b > 0) return (b + a) / 2;
  if (l != null && l > 0) return l;
  if (b != null && b > 0) return b;
  if (a != null && a > 0) return a;
  return 0;
}

function spreadPct(bid, ask) {
  const b = safeNumber(bid);
  const a = safeNumber(ask);
  if (b == null || a == null || a < b) return Infinity;
  const mid = (a + b) / 2;
  if (mid <= 0) return Infinity;
  return (a - b) / mid;
}

function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-ax * ax));
  return sign * y;
}

function normCdf(x) {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

function blackScholesPutDelta({ S, K, T, sigma, r = 0.045 }) {
  if (!S || !K || !T || !sigma || S <= 0 || K <= 0 || T <= 0 || sigma <= 0) {
    return null;
  }
  const d1 =
    (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T));
  return normCdf(d1) - 1;
}

function normalizeOptionContract(contract, type, expiration, spot) {
  const bid = safeNumber(contract.bid, 0);
  const ask = safeNumber(contract.ask, 0);
  const lastPrice = safeNumber(contract.lastPrice, 0);
  const strike = safeNumber(contract.strike);
  const iv = safeNumber(contract.impliedVolatility);
  const volume = safeNumber(contract.volume, 0);
  const openInterest = safeNumber(contract.openInterest, 0);
  const exp = contract.expiration ? new Date(contract.expiration) : expiration;
  const dte = daysToExpiration(exp);
  const T = yearFractionFromNow(exp);

  const mid = midFromBidAskOrLast(bid, ask, lastPrice);
  const relSpread = spreadPct(bid, ask);
  const delta =
    type === "put"
      ? blackScholesPutDelta({
          S: spot,
          K: strike,
          T,
          sigma: iv,
        })
      : null;

  return {
    contractSymbol: contract.contractSymbol,
    type,
    strike,
    bid,
    ask,
    lastPrice,
    mid,
    mark: mid,
    volume,
    openInterest,
    impliedVolatility: iv,
    inTheMoney: Boolean(contract.inTheMoney),
    contractSize: contract.contractSize,
    currency: contract.currency,
    expiration: exp.toISOString(),
    expirationDate: toISODateOnly(exp),
    lastTradeDate: contract.lastTradeDate
      ? new Date(contract.lastTradeDate).toISOString()
      : null,
    dte,
    spreadPct: Number.isFinite(relSpread) ? relSpread : null,
    delta,
  };
}

function getSpotFromQuote(quote) {
  return (
    safeNumber(quote?.regularMarketPrice) ??
    safeNumber(quote?.postMarketPrice) ??
    safeNumber(quote?.preMarketPrice) ??
    safeNumber(quote?.previousClose) ??
    null
  );
}

function scoreDte(dte) {
  if (dte >= 21 && dte <= 35) return 1.0;
  if (dte >= 14 && dte <= 20) return 0.85;
  if (dte >= 36 && dte <= 45) return 0.75;
  if (dte >= 7 && dte <= 13) return 0.5;
  return 0;
}

function clamp(x, min, max) {
  return Math.max(min, Math.min(max, x));
}

function normalize(x, min, max) {
  if (max <= min) return 0;
  return clamp((x - min) / (max - min), 0, 1);
}

function scorePutForWheel(put, spot, cfg = {}) {
  const {
    deltaMin = 0.2,
    deltaMax = 0.3,
    targetDelta = 0.25,
    minOpenInterest = 100,
    minVolume = 10,
    maxSpreadPct = 0.1,
  } = cfg;

  const absDelta = Math.abs(put.delta ?? NaN);
  if (!Number.isFinite(absDelta)) return null;
  if (absDelta < deltaMin || absDelta > deltaMax) return null;
  if ((put.openInterest ?? 0) < minOpenInterest) return null;
  if ((put.volume ?? 0) < minVolume) return null;
  if ((put.spreadPct ?? Infinity) > maxSpreadPct) return null;
  if ((put.mid ?? 0) <= 0) return null;
  if ((put.strike ?? 0) <= 0) return null;
  if ((put.dte ?? 0) <= 0) return null;

  const premium = put.mid * 100;
  const collateral = put.strike * 100;
  const roc = premium / collateral;
  const annualizedYield = roc * (365 / put.dte);
  const otmPct = (spot - put.strike) / spot;
  const breakEven = put.strike - put.mid;

  const scoreDelta = 1 - clamp(Math.abs(absDelta - targetDelta) / 0.1, 0, 1);
  const liquidityScore =
    0.4 * normalize(Math.log1p(put.openInterest), Math.log1p(minOpenInterest), Math.log1p(5000)) +
    0.3 * normalize(Math.log1p(put.volume), Math.log1p(minVolume), Math.log1p(1000)) +
    0.3 * (1 - normalize(put.spreadPct, 0, maxSpreadPct));

  const premiumRiskScore =
    0.5 * normalize(annualizedYield, 0.05, 0.5) +
    0.3 * normalize(otmPct, 0.01, 0.15) +
    0.2 * normalize((spot - breakEven) / spot, 0.01, 0.15);

  const totalScore =
    0.3 * scoreDelta +
    0.2 * scoreDte(put.dte) +
    0.25 * premiumRiskScore +
    0.25 * liquidityScore;

  return {
    ...put,
    premium,
    collateral,
    returnOnCollateral: roc,
    annualizedYield,
    otmPct,
    breakEven,
    totalScore,
  };
}

async function fetchOptionsForExpiration(symbol, expirationInput) {
  const expirationDate = normalizeExpirationInput(expirationInput);

  console.error("FETCH OPTIONS FOR:", symbol, expirationDate.toISOString());

  const data = await yahooFinance.options(symbol, { date: expirationDate });
  console.error("RAW OPTIONS RESPONSE:", JSON.stringify(data, null, 2));

  const quote = data?.quote ?? {};
  const spot = getSpotFromQuote(quote);

  let callsRaw = [];
  let putsRaw = [];
  let resolvedExpiration = expirationDate;

  if (Array.isArray(data?.options) && data.options.length > 0) {
    const bucket = data.options[0];
    callsRaw = Array.isArray(bucket?.calls) ? bucket.calls : [];
    putsRaw = Array.isArray(bucket?.puts) ? bucket.puts : [];

    if (bucket?.expirationDate) {
      resolvedExpiration = new Date(bucket.expirationDate);
    }
  }

  if (callsRaw.length === 0 && Array.isArray(data?.calls)) {
    callsRaw = data.calls;
  }

  if (putsRaw.length === 0 && Array.isArray(data?.puts)) {
    putsRaw = data.puts;
  }

  if (callsRaw.length === 0 && putsRaw.length === 0 && data && typeof data === "object") {
    for (const key of Object.keys(data)) {
      const value = data[key];

      if (Array.isArray(value) && value.length > 0) {
        const first = value[0];

        if (first && typeof first === "object" && "strike" in first) {
          const maybeCalls = value.filter(
            (x) =>
              typeof x?.contractSymbol === "string" &&
              x.contractSymbol.includes("C")
          );

          const maybePuts = value.filter(
            (x) =>
              typeof x?.contractSymbol === "string" &&
              x.contractSymbol.includes("P")
          );

          if (maybeCalls.length > 0 || maybePuts.length > 0) {
            callsRaw = maybeCalls;
            putsRaw = maybePuts;
            break;
          }
        }
      }
    }
  }

  const calls = callsRaw.map((c) =>
    normalizeOptionContract(c, "call", resolvedExpiration, spot)
  );

  const puts = putsRaw.map((p) =>
    normalizeOptionContract(p, "put", resolvedExpiration, spot)
  );

  return {
    symbol,
    quote,
    spot,
    underlyingSymbol: data?.underlyingSymbol ?? symbol,
    expiration: resolvedExpiration.toISOString(),
    expirationDate: toISODateOnly(resolvedExpiration),
    dte: daysToExpiration(resolvedExpiration),
    hasMiniOptions: Boolean(data?.hasMiniOptions),
    strikes: Array.isArray(data?.strikes) ? data.strikes : [],
    calls,
    puts,
    rawCount: {
      calls: calls.length,
      puts: puts.length,
    },
  };
}

function findNearestStrike(contracts, spot) {
  if (!Array.isArray(contracts) || contracts.length === 0 || !spot) return null;
  return contracts.reduce((best, c) => {
    if (!best) return c;
    return Math.abs(c.strike - spot) < Math.abs(best.strike - spot) ? c : best;
  }, null);
}

server.tool(
  "get_quote",
  {
    symbol: z.string(),
  },
  async ({ symbol }) => {
    const q = await yahooFinance.quote(symbol);
    const price = getSpotFromQuote(q);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              symbol,
              price,
              regularMarketPrice: q.regularMarketPrice ?? null,
              currency: q.currency ?? null,
              exchange: q.fullExchangeName ?? q.exchange ?? null,
              marketState: q.marketState ?? null,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_option_expirations",
  {
    symbol: z.string(),
  },
  async ({ symbol }) => {
    const data = await yahooFinance.options(symbol);
    const expirations = Array.isArray(data?.expirationDates)
      ? data.expirationDates.map((d) => ({
          date: d.toISOString(),
          dateOnly: toISODateOnly(d),
          dte: daysToExpiration(d),
        }))
      : [];

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              symbol,
              count: expirations.length,
              expirations,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_option_chain",
  {
    symbol: z.string(),
    expiration: z.string(),
  },
  async ({ symbol, expiration }) => {
    const chain = await fetchOptionsForExpiration(symbol, expiration);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(chain, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "get_expected_move",
  {
    symbol: z.string(),
    expiration: z.string(),
  },
  async ({ symbol, expiration }) => {
    const chain = await fetchOptionsForExpiration(symbol, expiration);

    if (!chain.spot) {
      throw new Error(`No underlying spot price found for ${symbol}`);
    }

    const allNearATM = [...chain.calls, ...chain.puts];
    if (allNearATM.length === 0) {
      throw new Error(`No option contracts found for ${symbol} ${expiration}`);
    }

    const atmCall = findNearestStrike(chain.calls, chain.spot);
    const atmPut = findNearestStrike(chain.puts, chain.spot);

    let expectedMoveDollars = null;
    let method = null;

    if (atmCall && atmPut) {
      expectedMoveDollars = (atmCall.mid ?? 0) + (atmPut.mid ?? 0);
      method = "atm_straddle";
    }

    if (!expectedMoveDollars || expectedMoveDollars <= 0) {
      const atm = atmCall || atmPut;
      if (atm?.impliedVolatility) {
        const T = yearFractionFromNow(expiration);
        expectedMoveDollars = chain.spot * atm.impliedVolatility * Math.sqrt(T);
        method = "spot_iv_sqrt_t";
      }
    }

    if (!expectedMoveDollars || expectedMoveDollars <= 0) {
      throw new Error(`Unable to compute expected move for ${symbol} ${expiration}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              symbol,
              expiration: chain.expiration,
              expirationDate: chain.expirationDate,
              dte: chain.dte,
              spot: chain.spot,
              method,
              expectedMoveDollars,
              expectedMovePct: expectedMoveDollars / chain.spot,
              range: {
                lower: chain.spot - expectedMoveDollars,
                upper: chain.spot + expectedMoveDollars,
              },
              atmReference: {
                call: atmCall
                  ? {
                      strike: atmCall.strike,
                      bid: atmCall.bid,
                      ask: atmCall.ask,
                      mid: atmCall.mid,
                      iv: atmCall.impliedVolatility,
                    }
                  : null,
                put: atmPut
                  ? {
                      strike: atmPut.strike,
                      bid: atmPut.bid,
                      ask: atmPut.ask,
                      mid: atmPut.mid,
                      iv: atmPut.impliedVolatility,
                    }
                  : null,
              },
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "get_best_strike",
  {
    symbol: z.string(),
    expiration: z.string().optional(),
    dteMin: z.number().default(7),
    dteMax: z.number().default(45),
    deltaMin: z.number().default(0.2),
    deltaMax: z.number().default(0.3),
    targetDelta: z.number().default(0.25),
    minOpenInterest: z.number().default(100),
    minVolume: z.number().default(10),
    maxSpreadPct: z.number().default(0.1),
  },
  async (args) => {
    const {
      symbol,
      expiration,
      dteMin,
      dteMax,
      deltaMin,
      deltaMax,
      targetDelta,
      minOpenInterest,
      minVolume,
      maxSpreadPct,
    } = args;

    const expirations = await yahooFinance.options(symbol);
    const validExpirations = (expirations?.expirationDates ?? [])
      .map((d) => ({
        date: d,
        dte: daysToExpiration(d),
      }))
      .filter((x) => x.dte >= dteMin && x.dte <= dteMax);

    const datesToScan = expiration
      ? [normalizeExpirationInput(expiration)]
      : validExpirations.map((x) => x.date);

    if (datesToScan.length === 0) {
      throw new Error(`No expirations found for ${symbol} in ${dteMin}-${dteMax} DTE`);
    }

    const candidates = [];

    for (const exp of datesToScan) {
      const chain = await fetchOptionsForExpiration(symbol, exp);

      for (const put of chain.puts) {
        const scored = scorePutForWheel(put, chain.spot, {
          deltaMin,
          deltaMax,
          targetDelta,
          minOpenInterest,
          minVolume,
          maxSpreadPct,
        });

        if (scored) {
          candidates.push({
            symbol,
            spot: chain.spot,
            expiration: chain.expiration,
            expirationDate: chain.expirationDate,
            dte: chain.dte,
            ...scored,
          });
        }
      }
    }

    candidates.sort((a, b) => b.totalScore - a.totalScore);
    const best = candidates[0] ?? null;

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              symbol,
              filters: {
                expiration: expiration ?? null,
                dteMin,
                dteMax,
                deltaMin,
                deltaMax,
                targetDelta,
                minOpenInterest,
                minVolume,
                maxSpreadPct,
              },
              best,
              alternatives: candidates.slice(0, 10),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);