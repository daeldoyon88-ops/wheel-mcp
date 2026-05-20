import { createMarketService } from "../app/services/marketService.js";
import { YahooMarketDataProvider } from "../app/data_providers/yahooMarketDataProvider.js";

const provider = new YahooMarketDataProvider();
const marketService = createMarketService(provider);

const SYMBOLS = ["BMNR", "RIOT", "CDE", "TEM", "CCL", "TQQQ", "APLD", "INTC"];
const REQUESTED_DATES = ["2026-05-18", "2026-05-19", "2026-05-20"];

function addDays(dateYmd, days) {
  const dt = new Date(`${dateYmd}T12:00:00.000Z`);
  if (Number.isNaN(dt.getTime())) return null;
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function toIsoDateUtc(value) {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const dt = new Date(value > 1e12 ? value : value * 1000);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
  }
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}

function formatRawDate(value) {
  if (value instanceof Date) {
    return {
      type: "Date",
      repr: value.toISOString(),
      ymdUtc: toIsoDateUtc(value),
    };
  }
  if (typeof value === "number") {
    return {
      type: "number",
      repr: String(value),
      ymdUtc: toIsoDateUtc(value),
    };
  }
  return {
    type: typeof value,
    repr: value == null ? String(value) : String(value),
    ymdUtc: toIsoDateUtc(value),
  };
}

function summarizeQuote(quote) {
  const rawDate = formatRawDate(quote?.date);
  return {
    date: rawDate.repr,
    dateType: rawDate.type,
    ymdUtc: rawDate.ymdUtc,
    timestamp: quote?.timestamp ?? null,
    time: quote?.time ?? null,
    open: quote?.open ?? null,
    high: quote?.high ?? null,
    low: quote?.low ?? null,
    close: quote?.close ?? null,
    volume: quote?.volume ?? null,
  };
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function serializeError(error) {
  if (!error) return { message: "unknown_error" };
  return {
    name: error.name ?? null,
    message: error.message ?? String(error),
    code: error.code ?? null,
    errno: error.errno ?? null,
    type: error.type ?? null,
    cause:
      error.cause == null
        ? null
        : {
            name: error.cause.name ?? null,
            message: error.cause.message ?? String(error.cause),
            code: error.cause.code ?? null,
            errno: error.cause.errno ?? null,
          },
    stackTop: typeof error.stack === "string" ? error.stack.split("\n").slice(0, 3) : null,
  };
}

function getRecentBusinessDate() {
  const now = new Date();
  const probe = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0));
  while (probe.getUTCDay() === 0 || probe.getUTCDay() === 6) {
    probe.setUTCDate(probe.getUTCDate() - 1);
  }
  return probe.toISOString().slice(0, 10);
}

async function fetchChartWindow(symbol, targetDate, lookbackDays) {
  const period1 = new Date(`${addDays(targetDate, -lookbackDays)}T00:00:00.000Z`);
  const result = await provider.getChart(symbol, {
    period1,
    interval: "1d",
  });
  const quotes = Array.isArray(result?.quotes) ? result.quotes : [];
  const ymds = quotes.map((q) => toIsoDateUtc(q?.date)).filter(Boolean);
  const sample = quotes[0] ? summarizeQuote(quotes[0]) : null;
  return {
    ok: true,
    label: `period1=${period1.toISOString().slice(0, 10)} interval=1d`,
    quoteCount: quotes.length,
    firstDates: ymds.slice(0, 5),
    lastDates: ymds.slice(-5),
    uniqueDateFormats: unique(quotes.slice(0, 5).map((q) => `${typeof q?.date}:${q?.date instanceof Date ? "Date" : String(q?.date)}`)),
    sampleQuote: sample,
    hasExactDate: ymds.includes(targetDate),
    hasPrevDate: ymds.includes(addDays(targetDate, -1)),
    hasNextDate: ymds.includes(addDays(targetDate, 1)),
  };
}

async function runHistoricalWindowProbe(symbol, targetDate) {
  const scanDate = addDays(targetDate, -3);
  const expirationDate = addDays(targetDate, 2);
  const result = await marketService.getHistoricalWindowMetrics(symbol, scanDate, expirationDate);
  return {
    scanDate,
    expirationDate,
    result,
  };
}

async function auditOne(symbol, targetDate) {
  const exact = await marketService.getDailyOhlcForDate(symbol, targetDate);
  const windows = [];
  for (const lookbackDays of [10, 15, 20, 30, 60]) {
    try {
      windows.push(await fetchChartWindow(symbol, targetDate, lookbackDays));
    } catch (error) {
      windows.push({
        ok: false,
        label: `lookbackDays=${lookbackDays}`,
        error: serializeError(error),
      });
    }
  }
  const historyProbe = await runHistoricalWindowProbe(symbol, targetDate);
  return {
    symbol,
    targetDate,
    exact,
    nearDates: {
      prev: addDays(targetDate, -1),
      next: addDays(targetDate, 1),
    },
    windows,
    historicalWindow: historyProbe,
  };
}

function classify(audit) {
  const exactOk = audit?.exact?.ok === true;
  if (exactOk) return "A. Yahoo retourne OHLC correctement";

  const allWindowErrors = audit.windows.every((w) => w.ok === false);
  if (allWindowErrors) return "F. Erreur provider";

  const anyWindowWithQuotes = audit.windows.some((w) => w.ok && w.quoteCount > 0);
  const anyExactDate = audit.windows.some((w) => w.ok && w.hasExactDate);
  if (anyWindowWithQuotes && anyExactDate) return "B. Yahoo retourne des candles mais le parsing/date-match echoue";

  const anyNearDate = audit.windows.some((w) => w.ok && (w.hasPrevDate || w.hasNextDate));
  if (anyWindowWithQuotes && anyNearDate) return "C. Yahoo retourne des candles mais pas pour cette date exacte";

  const lowerError = String(audit?.exact?.error ?? "").toLowerCase();
  if (lowerError.includes("symbol") || lowerError.includes("ticker")) return "D. Yahoo ne connait pas le ticker";

  if (anyWindowWithQuotes && !anyExactDate && !anyNearDate) return "C. Yahoo ne retourne rien pour cette date";

  if (audit.targetDate > getRecentBusinessDate()) return "E. Donnee future ou indisponible";

  return "C. Yahoo ne retourne rien pour cette date";
}

async function main() {
  const recentBusinessDate = getRecentBusinessDate();
  const dates = unique([...REQUESTED_DATES, recentBusinessDate]);

  console.log("================================================================");
  console.log("DEBUG POST-ASSIGNMENT OHLC");
  console.log("================================================================");
  console.log(`Recent business date guess: ${recentBusinessDate}`);
  console.log(`Symbols: ${SYMBOLS.join(", ")}`);
  console.log(`Dates  : ${dates.join(", ")}`);

  const audits = [];
  for (const symbol of SYMBOLS) {
    for (const targetDate of dates) {
      console.log("\n----------------------------------------------------------------");
      console.log(`${symbol} @ ${targetDate}`);
      console.log("----------------------------------------------------------------");
      try {
        const audit = await auditOne(symbol, targetDate);
        audits.push(audit);
        console.log("getDailyOhlcForDate:", JSON.stringify(audit.exact, null, 2));
        console.log("HistoricalWindow probe:", JSON.stringify(audit.historicalWindow, null, 2));
        for (const window of audit.windows) {
          console.log(`Window ${window.label}:`);
          console.log(JSON.stringify(window, null, 2));
        }
        console.log(`Classification: ${classify(audit)}`);
      } catch (error) {
        const failure = {
          symbol,
          targetDate,
          error: serializeError(error),
        };
        audits.push(failure);
        console.log(JSON.stringify(failure, null, 2));
      }
    }
  }

  console.log("\n================================================================");
  console.log("SUMMARY");
  console.log("================================================================");
  const counts = new Map();
  for (const audit of audits) {
    const key = audit?.exact || audit?.windows ? classify(audit) : "F. Erreur provider";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [label, count] of counts.entries()) {
    console.log(`${label}: ${count}`);
  }
}

await main();
