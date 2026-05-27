import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TICKER_META_PATH = "wheel-dashboard/src/tickerMeta.js";
const DEBUG_OUTPUT_PATH = "debug/ticker-meta-coverage-latest.json";

const JS_TICKER_SOURCE_FILES = [
  "app/watchlist/researchExpandedPool.js",
  "app/watchlist/watchlistBuilder.js",
  "app/config/constants.js",
  "app/config/universeExcludedSymbols.js",
  "app/seasonality/seasonalityBacktest.js",
  "wheel-dashboard/src/dashboard.jsx",
  "wheel-dashboard/src/buildWheelShortlist.js",
  "wheel-dashboard/src/preIbkrPool.js",
  "wheel-dashboard/src/data/fallbackResearchTickers.js",
  "wheel-dashboard/src/components/SeasonalityPanel.jsx",
  "wheel-dashboard/src/components/JournalPopPanel.jsx",
  "wheel-dashboard/src/capitalComboPortfolio.js",
  "wheel-dashboard/src/data/wheelShortlist.js",
  "wheel-dashboard/data/wheelShortlist.js",
];

const JSON_TICKER_SOURCE_FILES = [
  "data/universe/universe.master.json",
  "data/universe/universe.core.json",
  "data/universe/universe.growth.json",
  "data/universe/universe.high_premium.json",
  "data/universe/universe.etf.json",
];

const TEXT_TICKER_SOURCE_FILES = [
  "data/universe/weekly_eligible_tradingview.txt",
];

const TICKERISH_DECLARATION_RE =
  /(?:export\s+)?const\s+([A-Z0-9_]*(?:TICKER|SYMBOL|WATCHLIST|POOL|FAVORITE|PINNED|CRYPTO|QUALITY|FOCUS|EARNINGS|SOURCE)[A-Z0-9_]*)\s*=\s*/g;

const NON_TICKER_WORDS = new Set([
  "API",
  "CSP",
  "GET",
  "POST",
  "PUT",
  "CALL",
  "TRUE",
  "FALSE",
  "NULL",
  "NAN",
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
]);

function absPath(relPath) {
  return join(REPO_ROOT, relPath);
}

function sourceLabel(relPath) {
  return relPath.replaceAll("\\", "/");
}

function normalizeTicker(raw) {
  let symbol = String(raw ?? "").trim().toUpperCase();
  if (symbol.startsWith("$")) symbol = symbol.slice(1);
  if (!symbol || symbol.length > 8) return null;
  if (NON_TICKER_WORDS.has(symbol)) return null;
  if (!/^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?$/.test(symbol)) return null;
  return symbol;
}

function addTicker(sourceMap, rawSymbol, source) {
  const symbol = normalizeTicker(rawSymbol);
  if (!symbol) return;
  if (!sourceMap.has(symbol)) sourceMap.set(symbol, new Set());
  sourceMap.get(symbol).add(source);
}

async function readTextIfExists(relPath) {
  const fullPath = absPath(relPath);
  if (!existsSync(fullPath)) return null;
  return readFile(fullPath, "utf8");
}

function findStatementEnd(text, startIndex) {
  let quote = null;
  let escaped = false;
  let squareDepth = 0;
  let curlyDepth = 0;
  let parenDepth = 0;

  for (let i = startIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }

    if (ch === "[") squareDepth += 1;
    else if (ch === "]") squareDepth = Math.max(0, squareDepth - 1);
    else if (ch === "{") curlyDepth += 1;
    else if (ch === "}") curlyDepth = Math.max(0, curlyDepth - 1);
    else if (ch === "(") parenDepth += 1;
    else if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === ";" && squareDepth === 0 && curlyDepth === 0 && parenDepth === 0) {
      return i + 1;
    }
  }

  return text.length;
}

function extractStringTickers(text, sourceMap, source) {
  const stringRe = /["'`]([A-Z][A-Z0-9.\-]{0,9})["'`]/g;
  for (const match of text.matchAll(stringRe)) {
    addTicker(sourceMap, match[1], source);
  }
}

function extractTickerishDeclarations(text, sourceMap, source) {
  TICKERISH_DECLARATION_RE.lastIndex = 0;
  for (const match of text.matchAll(TICKERISH_DECLARATION_RE)) {
    const start = match.index + match[0].length;
    const end = findStatementEnd(text, start);
    extractStringTickers(text.slice(start, end), sourceMap, source);
  }
}

function extractSymbolProperties(text, sourceMap, source) {
  const propRe = /(?:^|[,{]\s*)(?:["']?(?:symbol|ticker)["']?)\s*:\s*["']([A-Z][A-Z0-9.\-]{0,9})["']/gim;
  for (const match of text.matchAll(propRe)) {
    addTicker(sourceMap, match[1], source);
  }
}

function extractTickerMetaKeys(text) {
  const start = text.indexOf("TICKER_META");
  if (start < 0) return new Set();

  const firstBrace = text.indexOf("{", start);
  if (firstBrace < 0) return new Set();

  let quote = null;
  let escaped = false;
  let depth = 0;
  let end = text.length;

  for (let i = firstBrace; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  const body = text.slice(firstBrace + 1, end - 1);
  const out = new Set();
  const keyRe = /^\s*(?:(["'])([A-Z][A-Z0-9.\-]{0,9})\1|([A-Z][A-Z0-9.\-]{0,9}))\s*:/gm;
  for (const match of body.matchAll(keyRe)) {
    const symbol = normalizeTicker(match[2] || match[3]);
    if (symbol) out.add(symbol);
  }
  return out;
}

function extractJsonSymbols(value, sourceMap, source) {
  if (Array.isArray(value)) {
    for (const item of value) extractJsonSymbols(item, sourceMap, source);
    return;
  }

  if (!value || typeof value !== "object") return;

  const isDisabled = value.enabled === false || value.excluded === true;
  if (!isDisabled) {
    if (typeof value.symbol === "string") addTicker(sourceMap, value.symbol, source);
    if (typeof value.ticker === "string") addTicker(sourceMap, value.ticker, source);
  }

  for (const [key, nested] of Object.entries(value)) {
    if (key === "symbol" || key === "ticker") continue;
    extractJsonSymbols(nested, sourceMap, source);
  }
}

async function collectUniverseTickers() {
  const sourceMap = new Map();

  for (const relPath of JS_TICKER_SOURCE_FILES) {
    const text = await readTextIfExists(relPath);
    if (!text) continue;
    const source = sourceLabel(relPath);
    extractTickerishDeclarations(text, sourceMap, source);
    extractSymbolProperties(text, sourceMap, source);
  }

  for (const relPath of JSON_TICKER_SOURCE_FILES) {
    const text = await readTextIfExists(relPath);
    if (!text) continue;
    const source = sourceLabel(relPath);
    try {
      extractJsonSymbols(JSON.parse(text), sourceMap, source);
    } catch (err) {
      console.warn(`Source ignorée (JSON invalide) : ${source} (${err.message})`);
    }
  }

  for (const relPath of TEXT_TICKER_SOURCE_FILES) {
    const text = await readTextIfExists(relPath);
    if (!text) continue;
    const source = sourceLabel(relPath);
    for (const token of text.split(/[\s,;]+/)) {
      addTicker(sourceMap, token, source);
    }
  }

  return sourceMap;
}

async function collectTickerMetaTickers() {
  const text = await readTextIfExists(TICKER_META_PATH);
  if (!text) {
    throw new Error(`Fichier introuvable : ${TICKER_META_PATH}`);
  }
  return extractTickerMetaKeys(text);
}

function formatSources(sources) {
  return [...sources].sort((a, b) => a.localeCompare(b)).join(", ");
}

async function main() {
  const universeByTicker = await collectUniverseTickers();
  const tickerMetaTickers = await collectTickerMetaTickers();

  const universeTickers = [...universeByTicker.keys()].sort((a, b) => a.localeCompare(b));
  const missingTickers = universeTickers
    .filter((ticker) => !tickerMetaTickers.has(ticker))
    .map((ticker) => ({
      ticker,
      sources: [...universeByTicker.get(ticker)].sort((a, b) => a.localeCompare(b)),
    }));

  console.log(`Total tickers univers local : ${universeTickers.length}`);
  console.log(`Tickers dans tickerMeta.js : ${tickerMetaTickers.size}`);
  console.log(`Tickers manquants : ${missingTickers.length}`);
  console.log("");
  console.log("Tickers manquants :");
  if (missingTickers.length === 0) {
    console.log("Aucun ticker manquant.");
  } else {
    for (const item of missingTickers) {
      console.log(`${item.ticker} — trouvé dans ${formatSources(item.sources)}`);
    }
  }

  const debugPayload = {
    generatedAt: new Date().toISOString(),
    totalUniverseTickers: universeTickers.length,
    totalTickerMeta: tickerMetaTickers.size,
    missingCount: missingTickers.length,
    missingTickers,
    sourcesAudited: {
      js: JS_TICKER_SOURCE_FILES.map(sourceLabel),
      json: JSON_TICKER_SOURCE_FILES.map(sourceLabel),
      text: TEXT_TICKER_SOURCE_FILES.map(sourceLabel),
      tickerMeta: sourceLabel(TICKER_META_PATH),
    },
  };

  await mkdir(dirname(absPath(DEBUG_OUTPUT_PATH)), { recursive: true });
  await writeFile(absPath(DEBUG_OUTPUT_PATH), `${JSON.stringify(debugPayload, null, 2)}\n`, "utf8");
  console.log("");
  console.log(`Rapport JSON écrit : ${sourceLabel(DEBUG_OUTPUT_PATH)}`);
}

main().catch((err) => {
  console.error(`Audit tickerMeta échoué : ${err?.stack || err}`);
  process.exitCode = 1;
});
