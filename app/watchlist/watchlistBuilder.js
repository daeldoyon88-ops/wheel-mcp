import { MAX_SCAN_TICKERS } from "../config/constants.js";
import { toNumber } from "../utils/number.js";
import {
  evaluateAtmPutLiquidity,
  hasWeeklyStyleExpirations,
  passesMaxPrice,
  passesMinVolume,
} from "./watchlistFilters.js";
import { loadMergedUniverse } from "./universeLoader.js";

/** @typedef {import('./universeLoader.js').UniverseCategory} UniverseCategory */

/**
 * @typedef {Object} BuildWatchlistCriteria
 * @property {100|125|150|200} maxPrice
 * @property {number} minVolume
 * @property {boolean} requireLiquidOptions
 * @property {boolean} requireWeeklyOptions
 * @property {UniverseCategory[]} categories
 * @property {number} [limit]
 */

const QUOTE_TTL_MS = 90_000;
const EXP_TTL_MS = 300_000;
const CHAIN_TTL_MS = 120_000;
const TIER_1_ULTRA_LIQUID = [
  "TQQQ", "SOXL", "QQQ", "SPY", "IWM",
  "NVDA", "TSLA", "AMD", "PLTR", "SOFI",
  "AFRM", "HOOD", "INTC", "UBER",
];
const TIER_2_GOOD_WHEEL = [
  "DKNG", "SHOP", "RBLX", "SMCI", "COIN", "MSTR",
  "PYPL", "ROKU", "SNAP", "NFLX", "LI", "NIO", "XPEV",
  "SQ", "U", "UPST", "MRNA", "GM", "DAL",
];
const TIER_3_SPECULATIVE = [
  "APLD", "ASTS", "BBAI", "ACHR", "IONQ", "RKLB",
  "AI", "AA", "AG", "AGQ", "AMC", "ALT",
];
const PRIORITY_WHEEL_SYMBOLS = [
  ...TIER_1_ULTRA_LIQUID,
  ...TIER_2_GOOD_WHEEL,
  ...TIER_3_SPECULATIVE,
];
const TIER_1_SET = new Set(TIER_1_ULTRA_LIQUID);
const TIER_2_SET = new Set(TIER_2_GOOD_WHEEL);
const TIER_3_SET = new Set(TIER_3_SPECULATIVE);
const PRIORITY_WHEEL_SET = new Set(PRIORITY_WHEEL_SYMBOLS);
const CATEGORY_PRIORITY = {
  weekly: 1,
  core: 2,
  growth: 3,
};

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} fn
 * @param {() => boolean} [shouldStop]
 */
async function runPool(items, limit, fn, shouldStop = undefined) {
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let idx = 0;
  async function worker() {
    while (true) {
      if (typeof shouldStop === "function" && shouldStop()) return;
      const i = idx;
      idx += 1;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function getPriorityTier(symbol) {
  if (TIER_1_SET.has(symbol)) return 0;
  if (TIER_2_SET.has(symbol)) return 1;
  if (TIER_3_SET.has(symbol)) return 2;
  return 3;
}

/**
 * @param {{ symbol: string, category: UniverseCategory }} a
 * @param {{ symbol: string, category: UniverseCategory }} b
 */
function compareWatchlistPriority(a, b) {
  const aTier = getPriorityTier(a.symbol);
  const bTier = getPriorityTier(b.symbol);
  if (aTier !== bTier) return aTier - bTier;

  const aCategory = CATEGORY_PRIORITY[a.category] ?? 99;
  const bCategory = CATEGORY_PRIORITY[b.category] ?? 99;
  if (aCategory !== bCategory) return aCategory - bCategory;

  return a.symbol.localeCompare(b.symbol);
}

/**
 * @param {{ marketService: { getQuote: Function, getOptionExpirations: Function, getOptionChain: Function }, cache: { get: Function, set: Function }, concurrency?: number }} deps
 */
export function createWatchlistBuilder(deps) {
  const { marketService, cache, concurrency = 6 } = deps;

  /**
   * @param {string} symbol
   */
  async function getQuoteCached(symbol) {
    const key = `quote:${symbol}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const q = await marketService.getQuote(symbol);
    cache.set(key, q, QUOTE_TTL_MS);
    return q;
  }

  /**
   * @param {string} symbol
   */
  async function getExpirationsCached(symbol) {
    const key = `exp:${symbol}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const e = await marketService.getOptionExpirations(symbol);
    cache.set(key, e, EXP_TTL_MS);
    return e;
  }

  /**
   * @param {string} symbol
   * @param {string} expiration
   */
  async function getChainCached(symbol, expiration) {
    const key = `chain:${symbol}:${expiration}`;
    const hit = cache.get(key);
    if (hit) return hit;
    const c = await marketService.getOptionChain(symbol, expiration);
    cache.set(key, c, CHAIN_TTL_MS);
    return c;
  }

  /**
   * Première expiration >= aujourd’hui (tri ISO).
   *
   * @param {string[]} dates
   */
  function pickNearestExpiration(dates) {
    const today = new Date().toISOString().slice(0, 10);
    const sorted = (dates || []).filter((d) => typeof d === "string" && d >= today).sort();
    return sorted[0] ?? null;
  }

  /**
   * @param {BuildWatchlistCriteria} criteria
   */
  async function buildWatchlist(criteria) {
    const limit = Math.min(
      criteria.limit ?? MAX_SCAN_TICKERS,
      MAX_SCAN_TICKERS * 10
    );

    const source = loadMergedUniverse({ categories: criteria.categories })
      .filter((r) => r.enabled)
      .sort(compareWatchlistPriority);

    /** @type {string[]} */
    const watchlist = [];
    /** @type {{ symbol: string, category: UniverseCategory, reason: string, detail?: unknown }[]} */
    const rejected = [];
    /** @type {{ symbol: string, message: string }[]} */
    const errors = [];

    /** @type {{ symbol: string, category: UniverseCategory }[]} */
    const keptRows = [];

    await runPool(source, concurrency, async (row) => {
      const { symbol, category } = row;
      if (keptRows.length >= limit) return;
      try {
        const quote = await getQuoteCached(symbol);
        const spot = toNumber(quote?.regularMarketPrice);

        const priceCheck = passesMaxPrice(spot, criteria.maxPrice);
        if (!priceCheck.ok) {
          rejected.push({ symbol, category, reason: priceCheck.reason, detail: priceCheck.detail });
          return;
        }

        const volCheck = passesMinVolume(quote, criteria.minVolume);
        if (!volCheck.ok) {
          rejected.push({ symbol, category, reason: volCheck.reason, detail: volCheck.detail });
          return;
        }

        const today = new Date().toISOString().slice(0, 10);

        if (criteria.requireWeeklyOptions) {
          if (keptRows.length >= limit) return;
          const exp = await getExpirationsCached(symbol);
          const dates = Array.isArray(exp?.availableExpirations) ? exp.availableExpirations : [];
          if (!dates.length) {
            rejected.push({ symbol, category, reason: "expirations_unavailable" });
            return;
          }
          if (!hasWeeklyStyleExpirations(dates, today)) {
            rejected.push({ symbol, category, reason: "no_weekly_options", detail: { checkedExpirations: dates.length } });
            return;
          }
        }

        if (criteria.requireLiquidOptions) {
          if (keptRows.length >= limit) return;
          const exp = await getExpirationsCached(symbol);
          const dates = Array.isArray(exp?.availableExpirations) ? exp.availableExpirations : [];
          const nearest = pickNearestExpiration(dates);
          if (!nearest) {
            rejected.push({ symbol, category, reason: "chain_unavailable" });
            return;
          }
          const chain = await getChainCached(symbol, nearest);
          const spotForChain = toNumber(chain?.currentPrice) || spot;
          const liq = evaluateAtmPutLiquidity(chain, spotForChain);
          if (!liq.ok) {
            rejected.push({
              symbol,
              category,
              reason: "options_not_liquid",
              detail: { code: liq.reason, ...liq.detail },
            });
            return;
          }
        }

        keptRows.push({ symbol, category });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ symbol, message });
        rejected.push({ symbol, category, reason: "error", detail: { message } });
      }
    }, () => keptRows.length >= limit);

    keptRows.sort(compareWatchlistPriority);
    for (const r of keptRows) {
      if (watchlist.length >= limit) break;
      watchlist.push(r.symbol);
    }

    const overflow = keptRows.length - watchlist.length;
    const priorityCount = watchlist.filter((symbol) => PRIORITY_WHEEL_SET.has(symbol)).length;
    const tier1Count = watchlist.filter((symbol) => TIER_1_SET.has(symbol)).length;
    const tier2Count = watchlist.filter((symbol) => TIER_2_SET.has(symbol)).length;
    const tier3Count = watchlist.filter((symbol) => TIER_3_SET.has(symbol)).length;
    const stats = {
      sourceCount: source.length,
      keptCount: watchlist.length,
      rejectedCount: rejected.length,
      truncated: overflow > 0 ? overflow : 0,
      limitApplied: limit,
      priorityCount,
      tier1Count,
      tier2Count,
      tier3Count,
      top20Tickers: watchlist.slice(0, 20),
    };

    return {
      ok: true,
      criteria: {
        ...criteria,
        limit,
      },
      stats,
      watchlist,
      rejected,
      errors,
    };
  }

  return { buildWatchlist };
}
