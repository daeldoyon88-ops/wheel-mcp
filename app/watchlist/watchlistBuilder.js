import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_LIQUIDITY_OTM_PROBE_PCT, MAX_SCAN_TICKERS } from "../config/constants.js";
import { toNumber } from "../utils/number.js";
import {
  evaluateAtmPutLiquidity,
  evaluateOtmPutLiquidityProbe,
  hasWeeklyStyleExpirations,
  passesMaxContractCapital,
  passesMaxPrice,
  passesMinMarketCapB,
  passesMinPrice,
  passesMinVolume,
} from "./watchlistFilters.js";
import {
  atmSpreadToLiquidityScore,
  buildWatchlistYahooFunnelFlags,
  isYahooFunnelDiagnosticsV1Enabled,
  rejectionStageFromWatchlistReason,
} from "../diagnostics/yahooFunnelDiagnosticsV1.js";
import {
  evaluateYahooLiquidityV3RecoveryEligibility,
  isYahooLiquidityV3LiveSafeEnabled,
  isYahooLiquidityV3SimulationEnabled,
  LOG_YAHOO_LIQUIDITY_V3_LIVE,
  resolvedV3SimulationMaxAbsoluteSpread,
} from "../diagnostics/yahooLiquidityV3Simulation.js";
import { loadMasterUniverse, loadMergedUniverse } from "./universeLoader.js";
import {
  collectCryptoFilterDiagnostics,
  isCryptoDigitalAssetBlocked,
} from "./cryptoWheelFilter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {import('./universeLoader.js').UniverseCategory} UniverseCategory */

/**
 * @typedef {Object} BuildWatchlistCriteria
 * @property {100|125|150|200|250} maxPrice
 * @property {number} [minPrice] défaut côté API : 10 ; <= 0 désactive le plancher
 * @property {number} minVolume
 * @property {boolean} requireLiquidOptions
 * @property {boolean} requireWeeklyOptions
 * @property {number} [liquidityOtmProbePct] si requireLiquidOptions : exige en plus un put OTM liquide (0 = désactive la sonde ; défaut = DEFAULT_LIQUIDITY_OTM_PROBE_PCT côté serveur, surcharge env `LIQUIDITY_OTM_PROBE_PCT`)
 * @property {number} [maxContractCapital] si défini et > 0 : exige spot * 100 <= maxContractCapital
 * @property {number} [minMarketCapB] si défini et > 0 : rejette seulement si marketCapB connue < seuil (cache local)
 * @property {UniverseCategory[]} categories
 * @property {number} [limit]
 * @property {'strict'|'relaxed'} [watchlistMode] "relaxed" convertit les filtres Yahoo options en pénalités de score au lieu de rejets durs.
 */

const QUOTE_TTL_MS = 90_000;
const EXP_TTL_MS = 300_000;
const CHAIN_TTL_MS = 120_000;
const TIER_1_ULTRA_LIQUID = [
  "TQQQ", "SOXL", "TNA", "SSO", "QQQ", "SPY", "IWM",
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

/** ETF à levier favoris pour le classement Strict Watchlist (bonus sortScore uniquement, sans effet sur les filtres). */
const STRICT_WATCHLIST_FAVORITE_ETFS = new Set(["TQQQ", "TNA", "SSO"]);

const CATEGORY_PRIORITY = {
  weekly: 1,
  core: 2,
  growth: 3,
};

/**
 * Chemin data/universe/fundamentals.cache.json (lecture seule, aucun HTTP).
 */
function fundamentalsCachePathAbs() {
  return join(__dirname, "..", "..", "data", "universe", "fundamentals.cache.json");
}

/**
 * @returns {Map<string, { marketCapB?: unknown, symbol?: string }>}
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

/**
 * Bonus de classement Strict Watchlist pour les ETF à levier favoris.
 * N'affecte que sortScore — aucun effet sur watchlistScore, filtres Yahoo, IBKR ou Wheel.
 * SOXL exclu intentionnellement (échoue la logique Wheel indépendamment).
 */
function favoriteEtfBias(symbol) {
  const s = String(symbol || "").trim().toUpperCase();
  if (!STRICT_WATCHLIST_FAVORITE_ETFS.has(s)) return 0;
  if (s === "TQQQ") return 2;
  return 5; // TNA, SSO
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
 *   otmProbeOk?: boolean,
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

  if (ctx.otmProbeOk === true) {
    score += 4;
    reasons.push("sonde put OTM liquide");
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
   * Réduit une chaîne Yahoo pour rejouer hors ligne ATM + sonde OTM (read-only diagnostic).
   * Garde les puts les plus près du spot pour limiter la taille JSON.
   *
   * @param {{ puts?: unknown[], currentPrice?: unknown }} chain
   * @param {number} spot
   * @param {number} [maxPuts]
   */
  function trimChainForOtmReplay(chain, spot, maxPuts = 360) {
    const puts = Array.isArray(chain?.puts) ? chain.puts : [];
    const s = toNumber(spot);
    const trimmed = puts
      .map((p) => ({
        strike: toNumber(p?.strike),
        bid: p?.bid,
        ask: p?.ask,
        lastPrice: p?.lastPrice,
        volume: p?.volume,
        openInterest: p?.openInterest,
      }))
      .filter((p) => p.strike > 0);
    if (!Number.isFinite(s) || s <= 0) {
      return { currentPrice: chain?.currentPrice ?? null, puts: trimmed.slice(0, maxPuts) };
    }
    trimmed.sort((a, b) => Math.abs(a.strike - s) - Math.abs(b.strike - s));
    return { currentPrice: chain?.currentPrice ?? null, puts: trimmed.slice(0, maxPuts) };
  }

  /**
   * @param {BuildWatchlistCriteria} criteria
   */
  async function buildWatchlist(criteria) {
    const limit = Math.min(
      criteria.limit ?? MAX_SCAN_TICKERS,
      MAX_SCAN_TICKERS * 10
    );

    const fundamentalsBySymbol = loadFundamentalsBySymbolMap();

    /** @type {{ market_cap_unavailable_passed: number, market_cap_unavailable_etf_passed: number, market_cap_unavailable_equity_passed: number, market_cap_below_min_rejected: number }} */
    const marketCapDiag = {
      market_cap_unavailable_passed: 0,
      market_cap_unavailable_etf_passed: 0,
      market_cap_unavailable_equity_passed: 0,
      market_cap_below_min_rejected: 0,
    };

    const funnelDiag =
      isYahooFunnelDiagnosticsV1Enabled() ||
      isYahooLiquidityV3SimulationEnabled() ||
      isYahooLiquidityV3LiveSafeEnabled();

    const liveV3Safe = isYahooLiquidityV3LiveSafeEnabled();
    if (liveV3Safe) {
      console.warn(`${LOG_YAHOO_LIQUIDITY_V3_LIVE} enabled`);
    }

    /**
     * @param {{ symbol: string, category: UniverseCategory, reason: string, detail?: unknown }} r
     */
    function rejectedEntryToDiagShape(r) {
      return {
        symbol: r.symbol,
        rejectionStage: rejectionStageFromWatchlistReason(r.reason),
        rejectionReasons: [r.reason],
        partialMetrics: { category: r.category, detail: r.detail },
      };
    }

    /** @param {{ symbol: string, category: UniverseCategory, reason: string, detail?: unknown, _v3LiveRecoveryCtx?: unknown }[]} list */
    function stripV3LiveRecoveryCtx(list) {
      for (const entry of list) {
        if (entry && typeof entry === "object" && "_v3LiveRecoveryCtx" in entry) {
          delete entry._v3LiveRecoveryCtx;
        }
      }
    }

    /** @type {Record<string, unknown>} */
    const yahooLiquidityV3LiveSafe = {
      enabled: liveV3Safe,
      recoveredCount: 0,
      recoveredSymbols: [],
      highQualityRecovered: [],
      mediumQualityRecovered: [],
      excludedSummary: null,
    };

    const rawUniverse = loadMergedUniverse({ categories: criteria.categories }).filter((r) => r.enabled);
    const cryptoFilterDiag = collectCryptoFilterDiagnostics(
      rawUniverse.map((r) => r.symbol)
    );
    const cryptoBlockedRemovedCount = cryptoFilterDiag.cryptoBlockedRemovedCount;
    const cryptoBlockedRemovedSymbols = cryptoFilterDiag.cryptoBlockedRemovedSymbols;
    const cryptoAllowedRetained = cryptoFilterDiag.cryptoAllowedRetained;
    const source = rawUniverse
      .filter((r) => !isCryptoDigitalAssetBlocked(r.symbol))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    const otmReplayExport =
      String(process.env.WATCHLIST_OTM_REPLAY_PACK || "").toLowerCase() === "true" ||
      process.env.WATCHLIST_OTM_REPLAY_PACK === "1";

    /** @type {unknown[]} */
    const liquidityOtmReplayPack = [];

    /** @type {string[]} */
    const watchlist = [];
    /** @type {{ symbol: string, category: UniverseCategory, reason: string, detail?: unknown }[]} */
    const rejected = [];
    /** @type {{ symbol: string, message: string }[]} */
    const errors = [];

    /** @type {{ symbol: string, category: UniverseCategory, watchlistScore: number, watchlistScoreReasons: string[], tierLabel: string, tierBias: number, favoriteEtfBias: number, sortScore: number }[]} */
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

        const capitalCheck = passesMaxContractCapital(spot, criteria.maxContractCapital);
        if (!capitalCheck.ok) {
          rejected.push({ symbol, category, reason: capitalCheck.reason, detail: capitalCheck.detail });
          return;
        }

        const fundRow = fundamentalsBySymbol.get(symbol);
        const mcapCheck = passesMinMarketCapB(fundRow, criteria.minMarketCapB, row);
        if (!mcapCheck.ok && mcapCheck.reason) {
          marketCapDiag.market_cap_below_min_rejected += 1;
          rejected.push({ symbol, category, reason: mcapCheck.reason, detail: mcapCheck.detail });
          return;
        }
        if (mcapCheck.detail?.market_cap_unavailable_passed === true) {
          marketCapDiag.market_cap_unavailable_passed += 1;
          if (mcapCheck.diagnosticReason === "market_cap_unavailable_etf_passed") {
            marketCapDiag.market_cap_unavailable_etf_passed += 1;
          } else if (mcapCheck.diagnosticReason === "market_cap_unavailable_equity_passed") {
            marketCapDiag.market_cap_unavailable_equity_passed += 1;
          }
        }

        const today = new Date().toISOString().slice(0, 10);
        let hasWeeklyStyle = false;
        let atmSpreadPct = null;
        let optionLiquidityOk = false;
        let otmProbeOk = false;
        let probePctForDiag = 0;
        const isRelaxed = criteria.watchlistMode === "relaxed";
        /** @type {{ reason: string, score: number }[]} */
        const softPenalties = [];

        if (criteria.requireWeeklyOptions || isRelaxed) {
          const exp = await getExpirationsCached(symbol);
          const dates = Array.isArray(exp?.availableExpirations) ? exp.availableExpirations : [];
          if (!dates.length) {
            if (!isRelaxed) {
              rejected.push({ symbol, category, reason: "expirations_unavailable" });
              return;
            }
            softPenalties.push({ reason: "expirations_unavailable", score: -12 });
          } else if (!hasWeeklyStyleExpirations(dates, today)) {
            if (!isRelaxed) {
              rejected.push({ symbol, category, reason: "no_weekly_options", detail: { checkedExpirations: dates.length } });
              return;
            }
            softPenalties.push({ reason: "no_weekly_options", score: -10 });
          } else {
            hasWeeklyStyle = true;
          }
        }

        if (criteria.requireLiquidOptions || isRelaxed) {
          const exp = await getExpirationsCached(symbol);
          const dates = Array.isArray(exp?.availableExpirations) ? exp.availableExpirations : [];
          const nearest = pickNearestExpiration(dates);
          if (!nearest) {
            if (!isRelaxed) {
              rejected.push({ symbol, category, reason: "chain_unavailable" });
              return;
            }
            if (!softPenalties.some((p) => p.reason === "expirations_unavailable")) {
              softPenalties.push({ reason: "chain_unavailable", score: -10 });
            }
          } else {
            const chain = await getChainCached(symbol, nearest);
            const spotForChain = toNumber(chain?.currentPrice) || spot;
            const liq = evaluateAtmPutLiquidity(chain, spotForChain);
            if (!liq.ok) {
              if (!isRelaxed) {
                const detail = { code: liq.reason, ...liq.detail };
                rejected.push({
                  symbol,
                  category,
                  reason: "liquid_options_failed",
                  detail,
                  ...(liveV3Safe
                    ? {
                        _v3LiveRecoveryCtx: {
                          spot,
                          minPx,
                          maxPrice: criteria.maxPrice,
                          minVolume: criteria.minVolume,
                          volumeUsed: volCheck.detail?.volumeUsed ?? criteria.minVolume,
                          hasWeeklyStyle,
                          universeRow: {
                            symbol,
                            category,
                            sources: Array.isArray(row.sources) ? row.sources : [],
                            tags: row.tags,
                          },
                          probePctForDiag:
                            typeof criteria.liquidityOtmProbePct === "number" &&
                            Number.isFinite(criteria.liquidityOtmProbePct)
                              ? criteria.liquidityOtmProbePct
                              : DEFAULT_LIQUIDITY_OTM_PROBE_PCT,
                        },
                      }
                    : {}),
                });
                return;
              }
              softPenalties.push({ reason: "liquid_options_failed", score: -15 });
            } else {
              optionLiquidityOk = true;
              atmSpreadPct = liq.detail?.liquidity?.spreadPct ?? null;

              if (otmReplayExport) {
                const volUsedForReplay = volCheck.detail?.volumeUsed ?? criteria.minVolume;
                const probeForMeta =
                  typeof criteria.liquidityOtmProbePct === "number" && Number.isFinite(criteria.liquidityOtmProbePct)
                    ? criteria.liquidityOtmProbePct
                    : DEFAULT_LIQUIDITY_OTM_PROBE_PCT;
                liquidityOtmReplayPack.push({
                  symbol,
                  category,
                  universeRow: {
                    sources: Array.isArray(row.sources) ? row.sources : [],
                    tags: row.tags,
                  },
                  scoreCtx: {
                    spot,
                    maxPrice: criteria.maxPrice,
                    minPrice: minPx,
                    minVolume: criteria.minVolume,
                    volumeUsed: volUsedForReplay,
                    hasWeeklyStyle,
                    atmSpreadPct,
                  },
                  nearestExpiration: nearest,
                  tierBias: tierMicroBias(symbol),
                  probePctAtCapture: probeForMeta,
                  chain: trimChainForOtmReplay(chain, spotForChain),
                });
              }

              const probeRaw = criteria.liquidityOtmProbePct;
              const probePct =
                typeof probeRaw === "number" && Number.isFinite(probeRaw)
                  ? probeRaw
                  : DEFAULT_LIQUIDITY_OTM_PROBE_PCT;
              probePctForDiag = probePct;
              if (probePct > 0) {
                const otmProbe = evaluateOtmPutLiquidityProbe(chain, spotForChain, probePct);
                if (!otmProbe.ok) {
                  if (!isRelaxed) {
                    rejected.push({
                      symbol,
                      category,
                      reason: "liquid_options_otm_probe_failed",
                      detail: { minOtmPct: probePct, ...otmProbe },
                    });
                    return;
                  }
                  softPenalties.push({ reason: "liquid_options_otm_probe_failed", score: -8 });
                } else {
                  otmProbeOk = otmProbe.detail?.skipped !== true;
                }
              }
            }
          }
        }

        const volUsed = volCheck.detail?.volumeUsed ?? criteria.minVolume;
        const { score: rawWatchlistScore, reasons: rawWatchlistScoreReasons } = computeWatchlistCandidateScore(row, {
          spot,
          maxPrice: criteria.maxPrice,
          minPrice: minPx,
          minVolume: criteria.minVolume,
          volumeUsed: volUsed,
          hasWeeklyStyle,
          optionLiquidityOk,
          atmSpreadPct,
          otmProbeOk,
        });

        const softPenaltyTotal = isRelaxed && softPenalties.length > 0
          ? softPenalties.reduce((acc, p) => acc + p.score, 0)
          : 0;
        const watchlistScore = softPenaltyTotal !== 0
          ? Math.max(0, Math.min(120, Math.round(rawWatchlistScore + softPenaltyTotal)))
          : rawWatchlistScore;
        const watchlistScoreReasons = softPenalties.length > 0
          ? [...rawWatchlistScoreReasons, ...softPenalties.map((p) => p.reason)].slice(0, 8)
          : rawWatchlistScoreReasons;

        const V2_SCORE_FLOOR = 20;
        if (isRelaxed && watchlistScore < V2_SCORE_FLOOR) {
          rejected.push({
            symbol,
            category,
            reason: "below_score_floor",
            detail: { watchlistScore, softPenalties, floor: V2_SCORE_FLOOR },
          });
          return;
        }
        const tierBias = tierMicroBias(symbol);
        const etfBias = favoriteEtfBias(symbol);
        const tierLabel = tierLabelFromIndex(getPriorityTier(symbol));
        const atmLiquidityScore = funnelDiag ? atmSpreadToLiquidityScore(atmSpreadPct) : null;
        const mcapBRaw = fundRow != null && typeof fundRow === "object" ? toNumber(fundRow.marketCapB) : null;
        const marketCapB =
          Number.isFinite(mcapBRaw) && mcapBRaw > 0 ? Math.round(mcapBRaw * 1000) / 1000 : null;
        const otmProbeScore =
          funnelDiag && criteria.requireLiquidOptions && probePctForDiag > 0 ? (otmProbeOk ? 100 : 0) : null;

        /** @type {Record<string, unknown>} */
        const keptRow = {
          symbol,
          category,
          watchlistScore,
          watchlistScoreReasons,
          tierLabel,
          tierBias,
          favoriteEtfBias: etfBias,
          sortScore: watchlistScore + tierBias + etfBias,
          ...(isRelaxed && softPenalties.length > 0 ? { softPenalized: true, softPenalties } : {}),
        };
        if (funnelDiag) {
          Object.assign(keptRow, {
            quotePrice: spot,
            avgVolume: volUsed,
            marketCapB,
            weeklyOptionsAvailable: hasWeeklyStyle,
            atmLiquidityScore,
            otmProbeScore,
            tags: normalizeMasterTags(row.tags),
            sources: Array.isArray(row.sources) ? row.sources : [],
          });
        }
        keptRows.push(keptRow);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        errors.push({ symbol, message });
        rejected.push({ symbol, category, reason: "error", detail: { message } });
      }
    });

    /** @type {unknown[] | null} */
    let rejectedCandidatesBeforeYahooLiquidityV3LiveSafe = null;

    if (liveV3Safe && isYahooLiquidityV3SimulationEnabled()) {
      rejectedCandidatesBeforeYahooLiquidityV3LiveSafe = rejected.map((r) => ({
        symbol: r.symbol,
        rejectionStage: rejectionStageFromWatchlistReason(r.reason),
        rejectionReasons: [String(r.reason || "unknown")],
        partialMetrics: {
          category: r.category,
          detail: r.detail ?? null,
        },
      }));
    }

    if (liveV3Safe) {
      const v3Opts = { maxAbsoluteSpreadV3: resolvedV3SimulationMaxAbsoluteSpread() };

      /** @type {Record<string, number>} */
      const excludedSummary = {
        weak: 0,
        noRealBidAsk: 0,
        otmProbe: 0,
        spreadPctFailed: 0,
        patternNotPure: 0,
        otherLiquidFailures: 0,
        overCap: 0,
      };

      for (const r of rejected) {
        const ev = evaluateYahooLiquidityV3RecoveryEligibility(rejectedEntryToDiagShape(r), v3Opts);
        switch (ev.kind) {
          case "exclude_weak":
            excludedSummary.weak += 1;
            break;
          case "exclude_no_real_bid_ask":
            excludedSummary.noRealBidAsk += 1;
            break;
          case "exclude_otm":
            excludedSummary.otmProbe += 1;
            break;
          case "exclude_spread_pct":
            excludedSummary.spreadPctFailed += 1;
            break;
          case "exclude_pattern_not_pure":
            excludedSummary.patternNotPure += 1;
            break;
          case "exclude_other_liquid":
            excludedSummary.otherLiquidFailures += 1;
            break;
          case "exclude_over_cap":
            excludedSummary.overCap += 1;
            break;
          default:
            break;
        }
      }

      const nextRejected = [];
      /** @type {{ r: { symbol: string, category: UniverseCategory, reason: string, detail?: unknown, _v3LiveRecoveryCtx?: Record<string, unknown> }, ev: Record<string, unknown> }[]} */
      const recoveredPairs = [];

      for (const r of rejected) {
        if (r.reason === "liquid_options_failed" && r._v3LiveRecoveryCtx) {
          const ev = evaluateYahooLiquidityV3RecoveryEligibility(rejectedEntryToDiagShape(r), v3Opts);
          if (ev.kind === "recovered") {
            recoveredPairs.push({ r, ev });
            continue;
          }
        }
        nextRejected.push(r);
      }

      rejected.length = 0;
      rejected.push(...nextRejected);

      /** @type {string[]} */
      const recoveredSymbolsList = [];
      /** @type {string[]} */
      const highQualityRecoveredList = [];
      /** @type {string[]} */
      const mediumQualityRecoveredList = [];

      for (const { r, ev } of recoveredPairs) {
        const ctx = r._v3LiveRecoveryCtx;
        delete r._v3LiveRecoveryCtx;

        const universeRow = ctx?.universeRow;
        if (!universeRow || typeof universeRow !== "object") continue;

        const sym = String(universeRow.symbol || "").trim().toUpperCase();
        const cat = universeRow.category;
        const fundRowRec = fundamentalsBySymbol.get(sym);
        const mcapBRawRec =
          fundRowRec != null && typeof fundRowRec === "object" ? toNumber(fundRowRec.marketCapB) : null;
        const marketCapBRec =
          Number.isFinite(mcapBRawRec) && mcapBRawRec > 0 ? Math.round(mcapBRawRec * 1000) / 1000 : null;

        const atmSpreadPctSnap = toNumber(ev.liquiditySnapshot?.spreadPct);
        const volUsedRec = toNumber(ctx.volumeUsed);

        const { score: wlScore, reasons: wlReasons } = computeWatchlistCandidateScore(universeRow, {
          spot: toNumber(ctx.spot),
          maxPrice: criteria.maxPrice,
          minPrice: toNumber(ctx.minPx),
          minVolume: criteria.minVolume,
          volumeUsed: volUsedRec,
          hasWeeklyStyle: ctx.hasWeeklyStyle === true,
          optionLiquidityOk: true,
          atmSpreadPct: Number.isFinite(atmSpreadPctSnap) ? atmSpreadPctSnap : null,
        });

        const tierBiasRec = tierMicroBias(sym);
        const etfBiasRec = favoriteEtfBias(sym);
        const tierLabelRec = tierLabelFromIndex(getPriorityTier(sym));
        const atmLiqScoreRec = funnelDiag ? atmSpreadToLiquidityScore(atmSpreadPctSnap) : null;

        /** @type {Record<string, unknown>} */
        const keptRowRec = {
          symbol: sym,
          category: cat,
          watchlistScore: wlScore,
          watchlistScoreReasons: wlReasons,
          tierLabel: tierLabelRec,
          tierBias: tierBiasRec,
          favoriteEtfBias: etfBiasRec,
          sortScore: wlScore + tierBiasRec + etfBiasRec,
          recoveredByYahooLiquidityV3LiveSafe: true,
          v3Bucket: ev.bucket,
          recoveryReason: ev.recoveryReason,
          liquiditySnapshot: ev.liquiditySnapshot,
          v3RiskFlags: Array.isArray(ev.risks) ? ev.risks : [],
        };

        if (funnelDiag) {
          Object.assign(keptRowRec, {
            quotePrice: toNumber(ctx.spot),
            avgVolume: volUsedRec,
            marketCapB: marketCapBRec,
            weeklyOptionsAvailable: ctx.hasWeeklyStyle === true,
            atmLiquidityScore: atmLiqScoreRec,
            otmProbeScore: null,
            tags: normalizeMasterTags(universeRow.tags),
            sources: Array.isArray(universeRow.sources) ? universeRow.sources : [],
          });
        }

        keptRows.push(keptRowRec);
        recoveredSymbolsList.push(sym);
        if (ev.bucket === "high") highQualityRecoveredList.push(sym);
        else if (ev.bucket === "medium") mediumQualityRecoveredList.push(sym);
      }

      stripV3LiveRecoveryCtx(rejected);

      yahooLiquidityV3LiveSafe.excludedSummary = excludedSummary;
      yahooLiquidityV3LiveSafe.recoveredCount = [...new Set(recoveredSymbolsList)].length;
      yahooLiquidityV3LiveSafe.recoveredSymbols = [...new Set(recoveredSymbolsList)].sort();
      yahooLiquidityV3LiveSafe.highQualityRecovered = [...new Set(highQualityRecoveredList)].sort();
      yahooLiquidityV3LiveSafe.mediumQualityRecovered = [...new Set(mediumQualityRecoveredList)].sort();

      const hiN = yahooLiquidityV3LiveSafe.highQualityRecovered.length;
      const medN = yahooLiquidityV3LiveSafe.mediumQualityRecovered.length;
      console.warn(
        `${LOG_YAHOO_LIQUIDITY_V3_LIVE} recovered count=${yahooLiquidityV3LiveSafe.recoveredCount} high=${hiN} medium=${medN}`
      );
      console.warn(`${LOG_YAHOO_LIQUIDITY_V3_LIVE} weak excluded=${excludedSummary.weak}`);
      console.warn(`${LOG_YAHOO_LIQUIDITY_V3_LIVE} no_real_bid_ask excluded=${excludedSummary.noRealBidAsk}`);
      console.warn(`${LOG_YAHOO_LIQUIDITY_V3_LIVE} otm excluded=${excludedSummary.otmProbe}`);
    } else {
      stripV3LiveRecoveryCtx(rejected);
    }

    keptRows.sort((a, b) => {
      if (b.sortScore !== a.sortScore) return b.sortScore - a.sortScore;
      return a.symbol.localeCompare(b.symbol);
    });

    for (const r of keptRows) {
      if (watchlist.length >= limit) break;
      watchlist.push(r.symbol);
    }

    if (liveV3Safe) {
      console.warn(`${LOG_YAHOO_LIQUIDITY_V3_LIVE} final estimated watchlist=${watchlist.length}`);
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

    const softPenalizedCount = keptRows.filter((r) => r.softPenalized === true).length;
    const softRejectedByScore = rejected.filter((r) => r.reason === "below_score_floor").length;
    /** @type {Record<string, number>} */
    const topSoftPenaltyReasons = {};
    for (const r of keptRows) {
      if (!Array.isArray(r.softPenalties)) continue;
      for (const p of r.softPenalties) {
        const k = String(p.reason || "unknown");
        topSoftPenaltyReasons[k] = (topSoftPenaltyReasons[k] ?? 0) + 1;
      }
    }
    for (const r of rejected) {
      if (r.reason !== "below_score_floor" || !Array.isArray(r.detail?.softPenalties)) continue;
      for (const p of r.detail.softPenalties) {
        const k = String(p.reason || "unknown");
        topSoftPenaltyReasons[k] = (topSoftPenaltyReasons[k] ?? 0) + 1;
      }
    }

    const watchlistDiagnostics = keptRows.slice(0, Math.min(30, limit)).map((r) => ({
      symbol: r.symbol,
      watchlistScore: r.watchlistScore,
      watchlistScoreReasons: r.watchlistScoreReasons,
      tierLabel: r.tierLabel,
      tierBias: r.tierBias,
      favoriteEtfBias: r.favoriteEtfBias ?? 0,
      sortScore: r.sortScore,
    }));

    const probeForStats =
      criteria.requireLiquidOptions !== true
        ? null
        : typeof criteria.liquidityOtmProbePct === "number" && Number.isFinite(criteria.liquidityOtmProbePct)
          ? criteria.liquidityOtmProbePct
          : DEFAULT_LIQUIDITY_OTM_PROBE_PCT;

    const truncatedSymbols = keptRows.slice(limit).map((r) => r.symbol);

    const stats = {
      sourceCount: source.length,
      keptCount: watchlist.length,
      retainedAfterFiltersCount: keptRows.length,
      rejectedCount: rejected.length,
      truncated: overflow > 0 ? overflow : 0,
      /** Diagnostic seulement — symboles viables exclus par la limite watchlist (n’altère pas la sélection). */
      truncatedSymbols,
      limitApplied: limit,
      priorityCount,
      tier1Count,
      tier2Count,
      tier3Count,
      top20Tickers: watchlist.slice(0, 20),
      top30Tickers: top30,
      top30HardcodedTierCount,
      cryptoBlockedRemovedCount,
      cryptoBlockedRemovedSymbols,
      cryptoAllowedRetained,
      cryptoRelatedEquityPresent: cryptoFilterDiag.cryptoRelatedEquityPresent,
      rejectedByReason,
      fundamentalsCachePath: fundamentalsCachePathAbs(),
      fundamentalsCacheLoaded: fundamentalsBySymbol.size,
      marketCapDiagnostics: marketCapDiag,
      /** % OTM utilisé pour la sonde Yahoo (null si requireLiquidOptions false). 0 = sonde désactivée. */
      liquidityOtmProbePctApplied: probeForStats,
      liquidityOtmProbeActive:
        criteria.requireLiquidOptions === true &&
        typeof probeForStats === "number" &&
        probeForStats > 0,
      watchlistMode: criteria.watchlistMode ?? "strict",
      hardRejectedCount: rejected.filter((r) => r.reason !== "below_score_floor").length,
      softPenalizedCount,
      softRejectedByScore,
      topSoftPenaltyReasons,
    };

    const limitCutoffSortScore =
      keptRows.length === 0 ? 0 : keptRows[Math.min(limit, keptRows.length) - 1].sortScore;

    let watchlistDiagnosticsV1;
    if (funnelDiag) {
      const masterEnabledAll = loadMasterUniverse({ categories: [] });
      const universeTotalCount =
        masterEnabledAll !== null ? masterEnabledAll.length : rawUniverse.length;
      const universeAfterCategoryCount = rawUniverse.length;
      const universeAfterCryptoBlockCount = source.length;

      const minMcapB = toNumber(criteria.minMarketCapB);
      watchlistDiagnosticsV1 = {
        universeTotalCount,
        universeAfterCategoryCount,
        universeAfterCryptoBlockCount,
        watchlistKeptCount: watchlist.length,
        watchlistRejectedCount: rejected.length,
        watchlistTruncatedCount: overflow,
        fullRankedCandidates: keptRows.map((r, i) => {
          const excludedByLimit = i >= limit;
          const keptBeforeLimit = i < limit;
          const dataQualityFlags = [];
          if (minMcapB > 0 && (r.marketCapB == null || !Number.isFinite(r.marketCapB))) {
            dataQualityFlags.push("market_cap_unknown_allowed");
          }
          if (r.recoveredByYahooLiquidityV3LiveSafe === true) {
            dataQualityFlags.push("yahoo_liquidity_v3_live_safe_recovered");
          }
          const wf = buildWatchlistYahooFunnelFlags(
            {
              rankBeforeLimit: i + 1,
              watchlistScore: r.watchlistScore,
              sortScore: r.sortScore,
              excludedByLimit,
              atmLiquidityScore: r.atmLiquidityScore ?? null,
            },
            { limitCutoffSortScore }
          );
          return {
            symbol: r.symbol,
            rankBeforeLimit: i + 1,
            watchlistScore: r.watchlistScore,
            tier: r.tierLabel,
            favoriteEtfBias: r.favoriteEtfBias ?? 0,
            category: r.category,
            quotePrice: r.quotePrice ?? null,
            avgVolume: r.avgVolume ?? null,
            marketCap: r.marketCapB ?? null,
            weeklyOptionsAvailable: r.weeklyOptionsAvailable ?? false,
            atmLiquidityScore: r.atmLiquidityScore ?? null,
            otmProbeScore: r.otmProbeScore ?? null,
            rejectionReasons: [],
            keptBeforeLimit,
            excludedByLimit,
            tags: Array.isArray(r.tags) ? r.tags : [],
            dataQualityFlags,
            notes: Array.isArray(r.watchlistScoreReasons) ? [...r.watchlistScoreReasons] : [],
            excluded_by_limit_but_viable: wf.excluded_by_limit_but_viable,
            yahooFunnelExplicitFlags: wf.yahoo_funnel_flags_v1,
            recoveredByYahooLiquidityV3LiveSafe: r.recoveredByYahooLiquidityV3LiveSafe === true,
            v3Bucket: r.v3Bucket ?? null,
            recoveryReason: r.recoveryReason ?? null,
            liquiditySnapshot: r.liquiditySnapshot ?? null,
            v3RiskFlags: Array.isArray(r.v3RiskFlags) ? r.v3RiskFlags : [],
          };
        }),
        rejectedCandidates: rejected.map((r) => ({
          symbol: r.symbol,
          rejectionStage: rejectionStageFromWatchlistReason(r.reason),
          rejectionReasons: [String(r.reason || "unknown")],
          partialMetrics: {
            category: r.category,
            detail: r.detail ?? null,
          },
        })),
        futureInspectorHints: {
          yahooFunnelInspector: "fullRankedCandidates + rejectedCandidates",
          missedCandidates: "fullRankedCandidates (excluded_by_limit_but_viable) + rejectedCandidates",
          ibkrWasteAnalyzer: "scanFunnelDiagnosticsV1 après POST /scan_shortlist",
        },
      };
    }

    const base = {
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
      yahooLiquidityV3LiveSafe,
      ...(rejectedCandidatesBeforeYahooLiquidityV3LiveSafe
        ? { rejectedCandidatesBeforeYahooLiquidityV3LiveSafe }
        : {}),
      ...(watchlistDiagnosticsV1 ? { watchlistDiagnosticsV1 } : {}),
    };

    if (otmReplayExport) {
      return {
        ...base,
        liquidityOtmReplayPack,
        liquidityOtmReplayMeta: {
          capturedAt: new Date().toISOString(),
          universeCandidates: source.length,
          packEntries: liquidityOtmReplayPack.length,
          note: "Données Yahoo (chaîne tronquée) pour comparer la sonde OTM hors ligne. Définir WATCHLIST_OTM_REPLAY_PACK=0 pour désactiver.",
        },
      };
    }

    return base;
  }

  return { buildWatchlist };
}
