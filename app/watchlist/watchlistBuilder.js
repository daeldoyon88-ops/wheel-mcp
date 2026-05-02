import { MAX_SCAN_TICKERS } from "../config/constants.js";
import { toNumber } from "../utils/number.js";
import {
  evaluateAtmPutLiquidity,
  hasWeeklyStyleExpirations,
  passesMaxPrice,
  passesMinPrice,
  passesMinVolume,
} from "./watchlistFilters.js";
import { loadMergedUniverse } from "./universeLoader.js";

/** @typedef {import('./universeLoader.js').UniverseCategory} UniverseCategory */

/**
 * @typedef {Object} BuildWatchlistCriteria
 * @property {100|125|150|200} maxPrice
 * @property {number} [minPrice] défaut côté API : 10 ; <= 0 désactive le plancher
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

function normalizeMasterTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
}

function tierLabelFromIndex(tier) {
  if (tier === 0) return "T1";
  if (tier === 1) return "T2";
  if (tier === 2) return "T3";
  return "—";
}

/** Tie-break faible après le score dynamique (anciennes priorités). */
function tierMicroBias(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  const t = getPriorityTier(s);
  if (t === 0) return 2;
  if (t === 1) return 1;
  if (t === 2) return -2;
  return 0;
}

/**
 * Score watchlist dynamique (données déjà chargées dans buildWatchlist — pas d’API).
 *
 * @param {{ symbol: string, category: UniverseCategory, sources?: string[], tags?: unknown }} row
 * @param {{
 *   spot: number,
 *   maxPrice: number,
 *   minPrice: number,
 *   minVolume: number,
 *   volumeUsed: number,
 *   hasWeeklyStyle: boolean,
 *   optionLiquidityOk?: boolean,
 *   atmSpreadPct?: number | null,
 * }} ctx
 */
export function computeWatchlistCandidateScore(row, ctx) {
  const reasons = [];
  let score = 50;
  const sym = String(row?.symbol || "").trim().toUpperCase();
  const spot = toNumber(ctx.spot);
  const maxP = toNumber(ctx.maxPrice);
  const minP = toNumber(ctx.minPrice);
  const minVol = toNumber(ctx.minVolume);
  const volUsed = toNumber(ctx.volumeUsed);

  const volRatio = minVol > 0 ? volUsed / minVol : 1;
  if (volRatio >= 40) {
    score += 18;
    reasons.push("volume élevé vs seuil");
  } else if (volRatio >= 15) {
    score += 12;
  } else if (volRatio >= 5) {
    score += 7;
  } else if (volRatio >= 2) {
    score += 3;
  } else if (volRatio < 1.35) {
    score -= 8;
    reasons.push("volume juste au-dessus du min");
  }

  const priceRatio = maxP > 0 ? spot / maxP : 0;
  if (priceRatio >= 0.96) {
    score -= 16;
    reasons.push("prix très proche du maxPrice");
  } else if (priceRatio >= 0.88) {
    score -= 8;
    reasons.push("prix proche du plafond");
  } else if (priceRatio <= 0.55 && spot >= minP) {
    score += 6;
    reasons.push("marge sous le plafond");
  }

  const band = maxP - minP;
  if (band > 0) {
    const mid = (minP + maxP) / 2;
    const distNorm = Math.abs(spot - mid) / band;
    if (distNorm < 0.28) {
      score += 8;
      reasons.push("prix dans zone utile wheel");
    }
  }

  const sources = Array.isArray(row.sources) ? row.sources : [];
  if (sources.length >= 3) {
    score += 5;
    reasons.push("sources multiples");
  } else if (sources.length === 2) {
    score += 3;
  }

  const tgs = normalizeMasterTags(row.tags);
  if (tgs.includes("weekly_options")) {
    score += 3;
    reasons.push("tag weekly_options");
  }
  if (tgs.includes("core")) score += 2;
  if (tgs.includes("growth")) score += 1;
  if (tgs.some((t) => t.includes("speculative") || t.includes("high_risk"))) {
    score -= 5;
    reasons.push("tag spéculatif");
  }

  if (ctx.hasWeeklyStyle) {
    score += 4;
    reasons.push("options style hebdo");
  }

  if (ctx.optionLiquidityOk === true && ctx.atmSpreadPct != null) {
    const sp = Number(ctx.atmSpreadPct);
    if (Number.isFinite(sp) && sp <= 0.15) {
      score += 6;
      reasons.push("spread ATM put serré");
    } else if (Number.isFinite(sp) && sp <= 0.3) {
      score += 3;
    }
  }

  if (TIER_3_SET.has(sym)) {
    score -= 3;
    reasons.push("tier3 historique (léger malus)");
  }

  score = Math.max(0, Math.min(120, Math.round(score)));
  return { score, reasons: reasons.slice(0, 6) };
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
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    /** @type {string[]} */
    const watchlist = [];
    /** @type {{ symbol: string, category: UniverseCategory, reason: string, detail?: unknown }[]} */
    const rejected = [];
    /** @type {{ symbol: string, message: string }[]} */
    const errors = [];

    /** @type {{ symbol: string, category: UniverseCategory, watchlistScore: number, watchlistScoreReasons: string[], tierLabel: string, tierBias: number, sortScore: number }[]} */
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

        const minPx = typeof criteria.minPrice === "number" ? criteria.minPrice : 10;
        const minPriceCheck = passesMinPrice(spot, minPx);
        if (!minPriceCheck.ok) {
          rejected.push({ symbol, category, reason: minPriceCheck.reason, detail: minPriceCheck.detail });
          return;
        }

        const volCheck = passesMinVolume(quote, criteria.minVolume);
        if (!volCheck.ok) {
          rejected.push({ symbol, category, reason: volCheck.reason, detail: volCheck.detail });
          return;
        }

        const today = new Date().toISOString().slice(0, 10);
        let hasWeeklyStyle = false;
        let atmSpreadPct = null;
        let optionLiquidityOk = false;

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
          hasWeeklyStyle = true;
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
          optionLiquidityOk = true;
          atmSpreadPct = liq.detail?.liquidity?.spreadPct ?? null;
        }

        const volUsed = volCheck.detail?.volumeUsed ?? criteria.minVolume;
        const { score: watchlistScore, reasons: watchlistScoreReasons } = computeWatchlistCandidateScore(row, {
          spot,
          maxPrice: criteria.maxPrice,
          minPrice: minPx,
          minVolume: criteria.minVolume,
          volumeUsed: volUsed,
          hasWeeklyStyle,
          optionLiquidityOk,
          atmSpreadPct,
        });
        const tierBias = tierMicroBias(symbol);
        const tierLabel = tierLabelFromIndex(getPriorityTier(symbol));
        keptRows.push({
          symbol,
          category,
          watchlistScore,
          watchlistScoreReasons,
          tierLabel,
          tierBias,
          sortScore: watchlistScore + tierBias,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ symbol, message });
        rejected.push({ symbol, category, reason: "error", detail: { message } });
      }
    });

    keptRows.sort((a, b) => {
      if (b.sortScore !== a.sortScore) return b.sortScore - a.sortScore;
      return a.symbol.localeCompare(b.symbol);
    });

    for (const r of keptRows) {
      if (watchlist.length >= limit) break;
      watchlist.push(r.symbol);
    }

    const overflow = Math.max(0, keptRows.length - limit);
    const priorityCount = watchlist.filter((symbol) => PRIORITY_WHEEL_SET.has(symbol)).length;
    const tier1Count = watchlist.filter((symbol) => TIER_1_SET.has(symbol)).length;
    const tier2Count = watchlist.filter((symbol) => TIER_2_SET.has(symbol)).length;
    const tier3Count = watchlist.filter((symbol) => TIER_3_SET.has(symbol)).length;

    const top30 = watchlist.slice(0, 30);
    let top30HardcodedTierCount = 0;
    for (const sym of top30) {
      if (PRIORITY_WHEEL_SET.has(sym)) top30HardcodedTierCount += 1;
    }

    /** @type {Record<string, number>} */
    const rejectedByReason = {};
    for (const r of rejected) {
      const k = r.reason ?? "unknown";
      rejectedByReason[k] = (rejectedByReason[k] ?? 0) + 1;
    }

    const watchlistDiagnostics = keptRows.slice(0, Math.min(30, limit)).map((r) => ({
      symbol: r.symbol,
      watchlistScore: r.watchlistScore,
      watchlistScoreReasons: r.watchlistScoreReasons,
      tierLabel: r.tierLabel,
      tierBias: r.tierBias,
      sortScore: r.sortScore,
    }));

    const stats = {
      sourceCount: source.length,
      keptCount: watchlist.length,
      retainedAfterFiltersCount: keptRows.length,
      rejectedCount: rejected.length,
      truncated: overflow > 0 ? overflow : 0,
      limitApplied: limit,
      priorityCount,
      tier1Count,
      tier2Count,
      tier3Count,
      top20Tickers: watchlist.slice(0, 20),
      top30Tickers: top30,
      top30HardcodedTierCount,
      rejectedByReason,
    };

    return {
      ok: true,
      criteria: {
        ...criteria,
        limit,
      },
      stats,
      watchlist,
      watchlistDiagnostics,
      rejected,
      errors,
    };
  }

  return { buildWatchlist };
}
