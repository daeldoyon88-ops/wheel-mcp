import fs from "fs/promises";

const TICKERS = [
  "CF", "SNOW", "KO", "SLB", "TSCO", "PCG", "DOCU", "PATH", "F", "WBD",
  "BITX", "SOFI", "ABT", "SCHW", "CSX", "NDAQ", "BAC", "CVS", "GM", "HIMS",
  "UBER", "TGT", "AFRM", "SBUX", "NFLX", "TQQQ", "EXPE", "SHOP", "AAPL", "SOXL",
  "AMZN", "AMD", "ORCL", "PLTR", "NVDA", "MSFT", "GOOGL", "MU", "AVGO", "TSM",
  "MRVL", "IBKR", "DUOL", "RYAAY", "NEM", "DELL", "KMI", "HOOD", "LVS", "TW",
  "NI", "FSLR", "INCY", "NBIX", "ROOT", "VST", "TECK", "ZM", "PYPL", "DECK",
  "NVO", "PHM", "DXCM", "USB", "PDD"
];

const EXPIRATION = process.argv[2] || "2026-04-24";
const API_BASE = "https://wheel-mcp.onrender.com";

const TARGET_WEEKLY = 0.005;
const ANNUALIZED_MIN = 0.26;

const EARNINGS_SYMBOLS = new Set([
  "NFLX"
]);

function daysBetween(fromDateStr, toDateStr) {
  const from = new Date(fromDateStr);
  const to = new Date(toDateStr);
  const ms = to - from;
  return Math.max(1, Math.round(ms / (1000 * 60 * 60 * 24)));
}

function weeklyYield(premium, strike, dteDays) {
  if (!premium || !strike || !dteDays) return 0;
  return (premium / strike) * (7 / dteDays);
}

function annualizedYield(weekly) {
  return weekly * 52;
}

function minPremiumForTarget(strike, dteDays, targetWeekly = TARGET_WEEKLY) {
  return strike * targetWeekly * (dteDays / 7);
}

function round(value, digits = 4) {
  if (value == null || Number.isNaN(value)) return null;
  return Number(value.toFixed(digits));
}

function getPremium(row) {
  if (!row) return 0;
  if (row.mid != null && row.mid > 0) return row.mid;
  if (row.lastPrice != null && row.lastPrice > 0) return row.lastPrice;
  return 0;
}

function pickCandidates(puts, lowerBound, dteDays) {
  const eligible = (puts || [])
    .filter((p) => p && typeof p.strike === "number")
    .filter((p) => p.strike < lowerBound)
    .filter((p) => getPremium(p) > 0)
    .sort((a, b) => b.strike - a.strike);

  if (!eligible.length) {
    return {
      safeStrike: null,
      maxPremiumStrike: null
    };
  }

  const maxPremiumStrike = eligible[0] || null;

  const safeStrike =
    eligible.find((p) => {
      const premium = getPremium(p);
      return premium >= minPremiumForTarget(p.strike, dteDays);
    }) || null;

  return {
    safeStrike,
    maxPremiumStrike
  };
}

function formatStrikeRow(symbol, price, lowerBound, row, dteDays) {
  if (!row) return null;

  const premium = getPremium(row);
  const weekly = weeklyYield(premium, row.strike, dteDays);
  const annualized = annualizedYield(weekly);
  const distancePct = price > 0 ? (price - row.strike) / price : 0;

  return {
    symbol,
    strike: row.strike,
    premium: round(premium, 3),
    distancePct: round(distancePct, 4),
    weeklyYield: round(weekly, 4),
    annualizedYield: round(annualized, 4),
    lowerBound: round(lowerBound, 3)
  };
}

function passesDashboardFilter(result) {
  if (!result) return false;
  if (!result.safeStrike) return false;

  return (
    result.safeStrike.weeklyYield >= TARGET_WEEKLY &&
    result.safeStrike.annualizedYield >= ANNUALIZED_MIN
  );
}

async function callTool(toolName, args) {
  const response = await fetch(`${API_BASE}/tools/${toolName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(args)
  });

  const payload = await response.json();

  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status} on ${toolName}`);
  }

  return payload.result;
}

async function getQuote(symbol) {
  return callTool("get_quote", { symbol });
}

async function getExpirations(symbol) {
  return callTool("get_option_expirations", { symbol });
}

async function getExpectedMove(symbol, expiration) {
  return callTool("get_expected_move", { symbol, expiration });
}

async function getOptionChain(symbol, expiration) {
  return callTool("get_option_chain", { symbol, expiration });
}

async function scanTicker(symbol, expiration, scanDate) {
  try {
    const expirationsData = await getExpirations(symbol);

    const availableExpirations =
      expirationsData.availableExpirations ||
      expirationsData.expirationDates ||
      expirationsData.expirations ||
      [];

    if (!availableExpirations.includes(expiration)) {
      return {
        symbol,
        skipped: true,
        reason: `expiration ${expiration} not available`
      };
    }

    const [quote, expectedMoveData, chain] = await Promise.all([
      getQuote(symbol),
      getExpectedMove(symbol, expiration),
      getOptionChain(symbol, expiration)
    ]);

    const price =
      quote.currentPrice ??
      quote.price ??
      quote.regularMarketPrice ??
      chain.currentPrice ??
      expectedMoveData.currentPrice;

    const expectedMove = expectedMoveData.expectedMove;
    const hasEarnings = EARNINGS_SYMBOLS.has(symbol);
    const adjustedMove = hasEarnings ? expectedMove * 2 : expectedMove;
    const lowerBound = price - adjustedMove;

    const dteDays = daysBetween(scanDate, expiration);

    const { safeStrike, maxPremiumStrike } = pickCandidates(
      chain.puts || [],
      lowerBound,
      dteDays
    );

    const safeStrikeFormatted = formatStrikeRow(
      symbol,
      price,
      lowerBound,
      safeStrike,
      dteDays
    );

    const maxPremiumStrikeFormatted = formatStrikeRow(
      symbol,
      price,
      lowerBound,
      maxPremiumStrike,
      dteDays
    );

    return {
      symbol,
      expiration,
      hasEarnings,
      currentPrice: round(price, 3),
      expectedMove: round(expectedMove, 3),
      adjustedMove: round(adjustedMove, 3),
      lowerBound: round(lowerBound, 3),
      dteDays,
      safeStrike: safeStrikeFormatted,
      maxPremiumStrike: maxPremiumStrikeFormatted,
      passesFilter: passesDashboardFilter({
        safeStrike: safeStrikeFormatted
      })
    };
  } catch (error) {
    return {
      symbol,
      skipped: true,
      reason: error.message
    };
  }
}

async function main() {
  const scanDate = new Date().toISOString().slice(0, 10);

  console.log(`\nScan started`);
  console.log(`API_BASE: ${API_BASE}`);
  console.log(`EXPIRATION: ${EXPIRATION}`);
  console.log(`SCAN_DATE: ${scanDate}\n`);

  const results = [];

  for (const symbol of TICKERS) {
    console.log(`Scanning ${symbol}...`);
    const result = await scanTicker(symbol, EXPIRATION, scanDate);
    results.push(result);
  }

  const fullResults = results.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const shortlist = fullResults
    .filter((r) => !r.skipped)
    .filter((r) => r.passesFilter)
    .sort((a, b) => {
      const aYield = a?.safeStrike?.annualizedYield ?? 0;
      const bYield = b?.safeStrike?.annualizedYield ?? 0;
      return bYield - aYield;
    });

  const outputDir = "./data";
  const outputFile = `${outputDir}/wheelShortlist.js`;
  const debugFile = `${outputDir}/wheelScanDebug.json`;

  await fs.mkdir(outputDir, { recursive: true });

  const jsContent = `export const wheelShortlist = ${JSON.stringify(shortlist, null, 2)};\n`;

  await fs.writeFile(outputFile, jsContent, "utf8");
  await fs.writeFile(debugFile, JSON.stringify(fullResults, null, 2), "utf8");

  console.log(`\nDone.`);
  console.log(`Shortlist written to: src/data/wheelShortlist.js`);
  console.log(`Debug scan written to: src/data/wheelScanDebug.json`);
  console.log(`Selected: ${shortlist.length}`);
  console.log(`Scanned: ${fullResults.length}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});