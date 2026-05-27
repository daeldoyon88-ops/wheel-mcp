import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const TICKER_META_PATH = "wheel-dashboard/src/tickerMeta.js";
const DEBUG_OUTPUT_PATH = "debug/ticker-meta-coverage-latest.json";
const DEBUG_RECENT_FILE_LIMIT = 20;
const DEBUG_BULK_FILE_RE = /yahoo-funnel-diagnostics/i;

const MASTER_SOURCE = "data/universe/universe.master.json";
const WEEKLY_SOURCE = "data/universe/weekly_eligible_tradingview.txt";
const CORE_SOURCE = "data/universe/universe.core.json";
const GROWTH_SOURCE = "data/universe/universe.growth.json";
const FALLBACK_RESEARCH_SOURCE = "wheel-dashboard/src/data/fallbackResearchTickers.js";
const STRICT_PRIORITY_A_UNKNOWN_VISIBLE = new Set([
  "TOST", "JOBY", "ON", "EL", "OWL", "EFA", "MOS", "JD", "SU", "GILD", "CHWY", "IAU", "PSKY", "VG",
]);

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
  /(?:export\s+)?const\s+([A-Z0-9_]*(?:TICKER|SYMBOL|WATCHLIST|POOL|FAVORITE|PINNED|MANUAL|MANDATORY|TRACK|CRYPTO|QUALITY|FOCUS|EARNINGS|SOURCE)[A-Z0-9_]*)\s*=\s*/g;

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

function addTickerToSet(symbolSet, rawSymbol) {
  const symbol = normalizeTicker(rawSymbol);
  if (symbol) symbolSet.add(symbol);
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

function extractStringTickerSymbols(text) {
  const stringRe = /["'`]([A-Z][A-Z0-9.\-]{0,9})["'`]/g;
  const symbols = [];
  for (const match of text.matchAll(stringRe)) {
    const symbol = normalizeTicker(match[1]);
    if (symbol) symbols.push(symbol);
  }
  return symbols;
}

function extractStringTickers(text, sourceMap, source) {
  for (const symbol of extractStringTickerSymbols(text)) {
    addTicker(sourceMap, symbol, source);
  }
}

function isManualTrackingDeclaration(name) {
  return /(?:PINNED|FAVORITE|MANUAL|MANDATORY|TRACK)/i.test(String(name || ""));
}

function extractTickerishDeclarations(text, sourceMap, source, manualTrackingTickers) {
  TICKERISH_DECLARATION_RE.lastIndex = 0;
  for (const match of text.matchAll(TICKERISH_DECLARATION_RE)) {
    const declarationName = match[1] || "";
    const start = match.index + match[0].length;
    const end = findStatementEnd(text, start);
    const block = text.slice(start, end);
    const symbols = extractStringTickerSymbols(block);
    for (const symbol of symbols) {
      addTicker(sourceMap, symbol, source);
      if (isManualTrackingDeclaration(declarationName)) addTickerToSet(manualTrackingTickers, symbol);
    }
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

function isDebugTickerKey(key) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return normalized.endsWith("symbol") ||
    normalized.endsWith("symbols") ||
    normalized.endsWith("ticker") ||
    normalized.endsWith("tickers");
}

function extractDebugTickerCandidates(value, out, parentKey = "") {
  if (typeof value === "string") {
    if (isDebugTickerKey(parentKey)) addTicker(out, value, "debug");
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractDebugTickerCandidates(item, out, parentKey);
    }
    return;
  }

  if (!value || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value)) {
    if (isDebugTickerKey(key) && typeof nested === "string") {
      addTicker(out, nested, "debug");
    } else {
      extractDebugTickerCandidates(nested, out, key);
    }
  }
}

async function collectRecentDebugTickers() {
  const debugDir = absPath("debug");
  if (!existsSync(debugDir)) return new Map();

  const outputSource = sourceLabel(DEBUG_OUTPUT_PATH);
  const entries = await readdir(debugDir, { withFileTypes: true });
  const jsonFiles = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
    if (DEBUG_BULK_FILE_RE.test(entry.name)) continue;
    const relPath = sourceLabel(join("debug", entry.name));
    if (relPath === outputSource || entry.name.startsWith("ticker-meta-coverage-")) continue;

    const fullPath = absPath(relPath);
    const fileStat = await stat(fullPath);
    jsonFiles.push({ relPath, mtimeMs: fileStat.mtimeMs });
  }

  jsonFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const recentFiles = jsonFiles.slice(0, DEBUG_RECENT_FILE_LIMIT);
  const byTicker = new Map();

  for (const file of recentFiles) {
    const text = await readTextIfExists(file.relPath);
    if (!text) continue;
    const localHits = new Map();
    try {
      extractDebugTickerCandidates(JSON.parse(text), localHits);
    } catch (err) {
      console.warn(`Debug ignoré (JSON invalide) : ${file.relPath} (${err.message})`);
      continue;
    }

    for (const ticker of localHits.keys()) {
      addTicker(byTicker, ticker, file.relPath);
    }
  }

  return byTicker;
}

async function collectUniverseTickers() {
  const sourceMap = new Map();
  const manualTrackingTickers = new Set();

  for (const relPath of JS_TICKER_SOURCE_FILES) {
    const text = await readTextIfExists(relPath);
    if (!text) continue;
    const source = sourceLabel(relPath);
    extractTickerishDeclarations(text, sourceMap, source, manualTrackingTickers);
    extractSymbolProperties(text, sourceMap, source);
  }

  for (const relPath of JSON_TICKER_SOURCE_FILES) {
    const text = await readTextIfExists(relPath);
    if (!text) continue;
    const source = sourceLabel(relPath);
    try {
      const parsed = JSON.parse(text);
      extractJsonSymbols(parsed, sourceMap, source);
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

  const debugTickers = await collectRecentDebugTickers();
  for (const [ticker, sources] of debugTickers.entries()) {
    for (const source of sources) addTicker(sourceMap, ticker, source);
  }

  return { sourceMap, manualTrackingTickers };
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

function buildPrioritySignals(item, manualTrackingTickers) {
  const sourceSet = new Set(item.sources);
  const sourceCount = sourceSet.size;
  const debugSources = item.sources.filter((source) => source.startsWith("debug/"));
  const nonDebugSources = item.sources.filter((source) => !source.startsWith("debug/"));
  const nonDebugSourceSet = new Set(nonDebugSources);
  const presentInCore = sourceSet.has(CORE_SOURCE);
  const presentInGrowth = sourceSet.has(GROWTH_SOURCE);
  const presentInCoreOrGrowth = sourceSet.has(CORE_SOURCE) || sourceSet.has(GROWTH_SOURCE);

  return {
    sourceCount,
    nonDebugSourceCount: nonDebugSourceSet.size,
    debugSources,
    seenInDebug: debugSources.length > 0,
    presentInWeeklyEligible: sourceSet.has(WEEKLY_SOURCE),
    presentInFallbackResearch: sourceSet.has(FALLBACK_RESEARCH_SOURCE),
    presentInCore,
    presentInGrowth,
    presentInCoreOrGrowth,
    presentInManualTracking: manualTrackingTickers.has(item.ticker),
    presentInMaster: sourceSet.has(MASTER_SOURCE),
    nonDebugSourceSet,
  };
}

function classifyMissingTicker(item, manualTrackingTickers) {
  const signals = buildPrioritySignals(item, manualTrackingTickers);
  const masterAndWeeklyOnly =
    signals.nonDebugSourceCount === 2 &&
    signals.nonDebugSourceSet.has(MASTER_SOURCE) &&
    signals.nonDebugSourceSet.has(WEEKLY_SOURCE);
  const hasStrongSource = signals.presentInCoreOrGrowth || signals.presentInFallbackResearch;

  const base = {
    ...item,
    sourceCount: signals.sourceCount,
    seenInDebug: signals.seenInDebug,
    presentInWeeklyEligible: signals.presentInWeeklyEligible,
    presentInFallbackResearch: signals.presentInFallbackResearch,
    presentInCoreOrGrowth: signals.presentInCoreOrGrowth,
  };

  const priorityAPlusReasons = [];
  if (STRICT_PRIORITY_A_UNKNOWN_VISIBLE.has(item.ticker)) {
    priorityAPlusReasons.push("ticker explicitement récent dans les inconnus visibles");
  }
  if (signals.seenInDebug && signals.presentInWeeklyEligible && hasStrongSource) {
    priorityAPlusReasons.push("debug récent + weekly_eligible_tradingview.txt + source forte");
  }
  if (signals.presentInFallbackResearch && signals.seenInDebug) {
    priorityAPlusReasons.push("fallbackResearchTickers.js + debug récent");
  }
  if (signals.presentInCore && signals.presentInGrowth && signals.presentInWeeklyEligible) {
    priorityAPlusReasons.push("universe.core.json + universe.growth.json + weekly_eligible_tradingview.txt");
  }

  if (priorityAPlusReasons.length > 0) {
    return {
      ...base,
      priority: "A+",
      priorityReason: priorityAPlusReasons.join("; "),
    };
  }

  const priorityAReasons = [];
  if (signals.seenInDebug && signals.nonDebugSourceCount >= 2) {
    priorityAReasons.push("debug récent + au moins 2 sources locales non-debug");
  }
  if (signals.presentInFallbackResearch) {
    priorityAReasons.push("présent dans fallbackResearchTickers.js");
  }
  if (signals.presentInCoreOrGrowth && signals.presentInWeeklyEligible) {
    priorityAReasons.push("core/growth + weekly_eligible_tradingview.txt");
  }
  if (signals.presentInManualTracking) {
    priorityAReasons.push("présent dans une liste pinned/favorites/manually tracked/mandatory tracking");
  }
  if (STRICT_PRIORITY_A_UNKNOWN_VISIBLE.has(item.ticker)) {
    priorityAReasons.push("ticker explicitement récent dans les inconnus visibles");
  }

  if (priorityAReasons.length > 0) {
    return {
      ...base,
      priority: "A",
      priorityReason: priorityAReasons.join("; "),
    };
  }

  const priorityBReasons = [];
  if (signals.nonDebugSourceCount === 2) {
    priorityBReasons.push("présent dans 2 sources locales non-debug");
  }
  if (masterAndWeeklyOnly) {
    priorityBReasons.push("weekly_eligible_tradingview.txt + universe.master.json seulement");
  }
  if (signals.seenInDebug) {
    priorityBReasons.push("vu dans debug récent sans confirmation forte");
  }

  if (priorityBReasons.length > 0) {
    return {
      ...base,
      priority: "B",
      priorityReason: priorityBReasons.join("; "),
    };
  }

  return {
    ...base,
    priority: "C",
    priorityReason: "source unique, source faible seulement ou jamais vu récemment",
  };
}

function comparePriorityItems(a, b) {
  if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
  return a.ticker.localeCompare(b.ticker);
}

function printPrioritySection(title, items) {
  console.log("");
  console.log(`${title} :`);
  if (items.length === 0) {
    console.log("Aucun ticker.");
    return;
  }
  const reasonLabel = title.includes("A+") ? "raison" : "raison priorité";
  console.log(`ticker | sources | ${reasonLabel}`);
  for (const item of items) {
    console.log(`${item.ticker} | ${formatSources(item.sources)} | ${item.priorityReason}`);
  }
}

async function main() {
  const { sourceMap: universeByTicker, manualTrackingTickers } = await collectUniverseTickers();
  const tickerMetaTickers = await collectTickerMetaTickers();

  const universeTickers = [...universeByTicker.keys()].sort((a, b) => a.localeCompare(b));
  const missingTickers = universeTickers
    .filter((ticker) => !tickerMetaTickers.has(ticker))
    .map((ticker) => ({
      ticker,
      sources: [...universeByTicker.get(ticker)].sort((a, b) => a.localeCompare(b)),
    }));

  const prioritizedMissing = missingTickers.map((item) => classifyMissingTicker(item, manualTrackingTickers));
  const priorityAPlus = prioritizedMissing
    .filter((item) => item.priority === "A+")
    .sort(comparePriorityItems);
  const priorityA = prioritizedMissing
    .filter((item) => item.priority === "A")
    .sort(comparePriorityItems);
  const priorityB = prioritizedMissing
    .filter((item) => item.priority === "B")
    .sort(comparePriorityItems);
  const priorityC = prioritizedMissing
    .filter((item) => item.priority === "C")
    .sort(comparePriorityItems);

  const totals = {
    totalUniverseTickers: universeTickers.length,
    totalTickerMeta: tickerMetaTickers.size,
    missingCount: missingTickers.length,
    priorityAPlusCount: priorityAPlus.length,
    priorityACount: priorityA.length,
    priorityBCount: priorityB.length,
    priorityCCount: priorityC.length,
  };
  const priorityWarning = priorityAPlus.length > 100
    ? "Priorité A+ trop large — critères à resserrer."
    : null;

  console.log("Résumé :");
  console.log(`Total tickers univers local : ${universeTickers.length}`);
  console.log(`Tickers dans tickerMeta.js : ${tickerMetaTickers.size}`);
  console.log(`Tickers manquants : ${missingTickers.length}`);
  console.log(`Priorité A+ : ${priorityAPlus.length}`);
  console.log(`Priorité A : ${priorityA.length}`);
  console.log(`Priorité B : ${priorityB.length}`);
  console.log(`Priorité C : ${priorityC.length}`);
  if (priorityWarning) console.log(priorityWarning);

  printPrioritySection("Priorité A+ — À ajouter maintenant", priorityAPlus);
  printPrioritySection("Priorité A", priorityA);
  printPrioritySection("Priorité B", priorityB);
  printPrioritySection("Priorité C", priorityC);

  const debugPayload = {
    generatedAt: new Date().toISOString(),
    totals,
    warning: priorityWarning,
    priorityAPlus,
    priorityA,
    priorityB,
    priorityC,
    sourcesAudited: {
      js: JS_TICKER_SOURCE_FILES.map(sourceLabel),
      json: JSON_TICKER_SOURCE_FILES.map(sourceLabel),
      text: TEXT_TICKER_SOURCE_FILES.map(sourceLabel),
      debugRecentLimit: DEBUG_RECENT_FILE_LIMIT,
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
