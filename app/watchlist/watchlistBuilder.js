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

/**
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<void>} fn
 */
async function runPool(items, limit, fn) {
  const concurrency = Math.max(1, Math.min(limit, items.length));
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx;
      idx += 1;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
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

    const source = loadMergedUniverse({ categories: criteria.categories }).filter((r) => r.enabled);

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
    });

    keptRows.sort((a, b) => a.symbol.localeCompare(b.symbol));
    for (const r of keptRows) {
      if (watchlist.length >= limit) break;
      watchlist.push(r.symbol);
    }

    const overflow = keptRows.length - watchlist.length;
    const stats = {
      sourceCount: source.length,
      keptCount: watchlist.length,
      rejectedCount: rejected.length,
      truncated: overflow > 0 ? overflow : 0,
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
