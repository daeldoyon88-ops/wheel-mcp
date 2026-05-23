import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { toNumber } from "../utils/number.js";
import { loadMergedUniverse } from "./universeLoader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Tickers crypto exclus du pipeline Wheel (aligné watchlistBuilder). */
const CRYPTO_BLOCKED_SYMBOLS = new Set([
  "IBIT", "BITO", "RIOT", "CIFR", "WULF", "IREN",
  "MARA", "CLSK", "HUT", "BTBT", "COIN", "BITF", "BMNR",
]);

const TIER_1_ULTRA_LIQUID = [
  "TQQQ", "SOXL", "TNA", "SSO", "QQQ", "SPY", "IWM",
  "NVDA", "TSLA", "AMD", "PLTR", "SOFI",
  "AFRM", "HOOD", "INTC", "UBER",
];

/** ETF à levier favoris — toujours en tête du pool Research Expanded (même si exclus du master). */
export const LEVERAGED_ETF_RESEARCH_PINNED = ["TQQQ", "SOXL", "TNA", "SSO"];
const LEVERAGED_ETF_RESEARCH_PINNED_SET = new Set(LEVERAGED_ETF_RESEARCH_PINNED);
const TIER_2_GOOD_WHEEL = [
  "DKNG", "SHOP", "RBLX", "SMCI", "COIN", "MSTR",
  "PYPL", "ROKU", "SNAP", "NFLX", "LI", "NIO", "XPEV",
  "SQ", "U", "UPST", "MRNA", "GM", "DAL",
];
const TIER_3_SPECULATIVE = [
  "APLD", "ASTS", "BBAI", "ACHR", "IONQ", "RKLB",
  "AI", "AA", "AG", "AGQ", "AMC", "ALT",
];
const TIER_1_SET = new Set(TIER_1_ULTRA_LIQUID);
const TIER_2_SET = new Set(TIER_2_GOOD_WHEEL);
const TIER_3_SET = new Set(TIER_3_SPECULATIVE);

const CATEGORY_PRIORITY = {
  weekly: 1,
  core: 2,
  growth: 3,
  high_premium: 4,
  etf: 5,
};

/**
 * @typedef {import('./universeLoader.js').UniverseCategory} UniverseCategory
 */

/**
 * @typedef {Object} BuildResearchExpandedCriteria
 * @property {150|200} [limit]
 * @property {number} [maxPrice] optionnel — filtre doux si prix connu dans le cache
 * @property {boolean} [includeAboveMaxPrice] si false, exclut les tickers au-dessus de maxPrice quand le prix est connu
 * @property {boolean} [flagUnreliable]
 * @property {UniverseCategory[]} [categories]
 */

function fundamentalsCachePathAbs() {
  return join(__dirname, "..", "..", "data", "universe", "fundamentals.cache.json");
}

/**
 * @returns {Map<string, { marketCapB?: unknown, regularMarketPrice?: unknown, price?: unknown }>}
 */
function loadFundamentalsBySymbolMap() {
  const pathAbs = fundamentalsCachePathAbs();
  if (!existsSync(pathAbs)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(pathAbs, "utf8"));
    const items = raw?.items && typeof raw.items === "object" ? raw.items : {};
    /** @type {Map<string, object>} */
    const map = new Map();
    for (const [key, val] of Object.entries(items)) {
      const sym = String(key).trim().toUpperCase();
      if (!sym || !val || typeof val !== "object") continue;
      map.set(sym, val);
    }
    return map;
  } catch {
    return new Map();
  }
}

function getPriorityTier(symbol) {
  if (TIER_1_SET.has(symbol)) return 0;
  if (TIER_2_SET.has(symbol)) return 1;
  if (TIER_3_SET.has(symbol)) return 2;
  return 3;
}

function categoryRank(category) {
  return CATEGORY_PRIORITY[category] ?? 99;
}

/**
 * Place les ETF levier épinglés en tête, puis le reste sans doublons, puis applique la limite.
 * @param {string[]} symbols
 * @param {number} limit
 */
function finalizeResearchExpandedPool(symbols, limit) {
  const normalized = symbols
    .map((symbol) => String(symbol || "").trim().toUpperCase())
    .filter(Boolean);
  const rest = normalized.filter((symbol) => !LEVERAGED_ETF_RESEARCH_PINNED_SET.has(symbol));
  return [...new Set([...LEVERAGED_ETF_RESEARCH_PINNED, ...rest])].slice(0, limit);
}

/**
 * Pool pré-IBKR élargi — sans filtres stricts watchlist (liquidité OTM, weekly obligatoire, cap contrat).
 * Source : universe.master.json (+ legacy si master absent).
 *
 * @param {BuildResearchExpandedCriteria} criteria
 */
export function buildResearchExpandedPool(criteria = {}) {
  const limitRaw = Number(criteria.limit);
  const limit = limitRaw === 150 ? 150 : 200;
  const maxPrice = toNumber(criteria.maxPrice);
  const hasMaxPrice = Number.isFinite(maxPrice) && maxPrice > 0;
  const includeAboveMaxPrice = criteria.includeAboveMaxPrice !== false;
  const flagUnreliable = criteria.flagUnreliable !== false;
  const categories = Array.isArray(criteria.categories) && criteria.categories.length > 0
    ? criteria.categories
    : ["weekly", "core", "growth", "high_premium", "etf"];

  const fundamentalsBySymbol = loadFundamentalsBySymbolMap();
  const rawUniverse = loadMergedUniverse({ categories }).filter((r) => r.enabled);
  const cryptoBlockedRemovedCount = rawUniverse.filter((r) =>
    CRYPTO_BLOCKED_SYMBOLS.has(String(r.symbol || "").toUpperCase())
  ).length;

  const seen = new Set();
  /** @type {{ symbol: string, category: UniverseCategory, sortTier: number, sortCategory: number, researchUnreliable?: boolean, knownPrice?: number | null }[]} */
  const ranked = [];

  for (const row of rawUniverse) {
    const symbol = String(row.symbol || "").trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    if (CRYPTO_BLOCKED_SYMBOLS.has(symbol)) continue;
    seen.add(symbol);

    const fundRow = fundamentalsBySymbol.get(symbol);
    const knownPrice =
      toNumber(fundRow?.regularMarketPrice) ||
      toNumber(fundRow?.price) ||
      toNumber(fundRow?.lastPrice) ||
      null;
    const researchUnreliable = flagUnreliable && !fundRow;

    if (hasMaxPrice && !includeAboveMaxPrice && Number.isFinite(knownPrice) && knownPrice > maxPrice) {
      continue;
    }

    ranked.push({
      symbol,
      category: row.category,
      sortTier: getPriorityTier(symbol),
      sortCategory: categoryRank(row.category),
      researchUnreliable,
      knownPrice: Number.isFinite(knownPrice) ? knownPrice : null,
    });
  }

  for (const symbol of LEVERAGED_ETF_RESEARCH_PINNED) {
    if (!symbol || seen.has(symbol) || CRYPTO_BLOCKED_SYMBOLS.has(symbol)) continue;
    seen.add(symbol);
    const fundRow = fundamentalsBySymbol.get(symbol);
    const knownPrice =
      toNumber(fundRow?.regularMarketPrice) ||
      toNumber(fundRow?.price) ||
      toNumber(fundRow?.lastPrice) ||
      null;
    const researchUnreliable = flagUnreliable && !fundRow;
    if (hasMaxPrice && !includeAboveMaxPrice && Number.isFinite(knownPrice) && knownPrice > maxPrice) {
      continue;
    }
    ranked.push({
      symbol,
      category: "etf",
      sortTier: 0,
      sortCategory: categoryRank("etf"),
      researchUnreliable,
      knownPrice: Number.isFinite(knownPrice) ? knownPrice : null,
    });
  }

  ranked.sort((a, b) => {
    if (a.sortTier !== b.sortTier) return a.sortTier - b.sortTier;
    if (a.sortCategory !== b.sortCategory) return a.sortCategory - b.sortCategory;
    return a.symbol.localeCompare(b.symbol);
  });

  const pool = finalizeResearchExpandedPool(
    ranked.map((row) => row.symbol),
    limit
  );
  const selectedBySymbol = new Map(ranked.map((row) => [row.symbol, row]));
  const selected = pool.map((symbol) => {
    const row = selectedBySymbol.get(symbol);
    if (row) return row;
    const fundRow = fundamentalsBySymbol.get(symbol);
    const knownPrice =
      toNumber(fundRow?.regularMarketPrice) ||
      toNumber(fundRow?.price) ||
      toNumber(fundRow?.lastPrice) ||
      null;
    return {
      symbol,
      category: "etf",
      sortTier: 0,
      sortCategory: categoryRank("etf"),
      researchUnreliable: flagUnreliable && !fundRow,
      knownPrice: Number.isFinite(knownPrice) ? knownPrice : null,
    };
  });

  return {
    ok: true,
    pool,
    poolSource: "research_expanded",
    stats: {
      universeSourceCount: rawUniverse.length,
      afterCryptoBlockCount: rawUniverse.length - cryptoBlockedRemovedCount,
      rankedCandidates: ranked.length,
      limitApplied: limit,
      keptCount: pool.length,
      cryptoBlockedRemovedCount,
      maxPriceApplied: hasMaxPrice ? maxPrice : null,
      includeAboveMaxPrice,
      flagUnreliable,
      unreliableCount: selected.filter((r) => r.researchUnreliable).length,
      categories,
    },
    candidates: selected.map((r, index) => ({
      symbol: r.symbol,
      rank: index + 1,
      category: r.category,
      researchExpanded: true,
      researchOnlyCandidate: true,
      poolSource: "research_expanded",
      researchUnreliable: r.researchUnreliable === true,
      knownPrice: r.knownPrice,
    })),
  };
}
