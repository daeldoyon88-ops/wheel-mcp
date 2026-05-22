import { FALLBACK_RESEARCH_TICKERS } from "./data/fallbackResearchTickers.js";

const API_BASE = "http://127.0.0.1:3001";

/** @typedef {"strict_watchlist" | "research_expanded" | "fallback_65"} PreIbkrPoolMode */

export const PRE_IBKR_POOL_MODES = Object.freeze([
  "strict_watchlist",
  "research_expanded",
  "fallback_65",
]);

export const PRE_IBKR_POOL_MODE_LABELS = Object.freeze({
  strict_watchlist: "Strict Watchlist",
  research_expanded: "Research Expanded",
  fallback_65: "Fallback 65",
});

/**
 * @param {unknown} raw
 * @returns {PreIbkrPoolMode}
 */
export function readStoredPreIbkrPoolMode(raw) {
  const value = String(raw || "").trim();
  if (PRE_IBKR_POOL_MODES.includes(value)) return value;
  return "research_expanded";
}

/**
 * @param {unknown} raw
 * @returns {150 | 200}
 */
export function readStoredResearchExpandedLimit(raw) {
  const value = Number(raw);
  return value === 150 ? 150 : 200;
}

/**
 * @param {{
 *   watchlistTickers: string[] | null,
 *   preIbkrPoolMode: PreIbkrPoolMode,
 *   researchExpandedPool: string[],
 *   researchExpandedLimit: 150 | 200,
 *   fallbackTickers: string[],
 * }} params
 * @returns {{ tickers: string[], poolSource: PreIbkrPoolMode | "strict_watchlist" | "research_expanded" | "fallback_65", usedFallbackUltimate: boolean }}
 */
export function resolvePreIbkrTickers({
  watchlistTickers,
  preIbkrPoolMode,
  researchExpandedPool,
  researchExpandedLimit,
  fallbackTickers,
}) {
  if (Array.isArray(watchlistTickers) && watchlistTickers.length > 0) {
    return {
      tickers: watchlistTickers,
      poolSource: "strict_watchlist",
      usedFallbackUltimate: false,
    };
  }

  if (preIbkrPoolMode === "strict_watchlist") {
    return {
      tickers: [],
      poolSource: "strict_watchlist",
      usedFallbackUltimate: false,
    };
  }

  if (preIbkrPoolMode === "fallback_65") {
    return {
      tickers: Array.isArray(fallbackTickers) ? fallbackTickers : [],
      poolSource: "fallback_65",
      usedFallbackUltimate: false,
    };
  }

  const pool = (Array.isArray(researchExpandedPool) ? researchExpandedPool : [])
    .map((t) => String(t || "").trim().toUpperCase())
    .filter(Boolean);
  const unique = [...new Set(pool)].slice(0, researchExpandedLimit);

  if (unique.length > 0) {
    return {
      tickers: unique,
      poolSource: "research_expanded",
      usedFallbackUltimate: false,
    };
  }

  return {
    tickers: Array.isArray(fallbackTickers) ? fallbackTickers : [],
    poolSource: "fallback_65",
    usedFallbackUltimate: true,
  };
}

/**
 * @param {{
 *   limit?: 150 | 200,
 *   maxPrice?: number | null,
 *   includeAboveMaxPrice?: boolean,
 *   flagUnreliable?: boolean,
 * }} [options]
 */
export async function callResearchExpandedPool(options = {}) {
  const response = await fetch(`${API_BASE}/universe/research`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      limit: options.limit ?? 200,
      maxPrice: options.maxPrice ?? null,
      includeAboveMaxPrice: options.includeAboveMaxPrice !== false,
      flagUnreliable: options.flagUnreliable !== false,
    }),
  });

  const payload = await response.json();
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `HTTP ${response.status}`);
  }
  return payload;
}

/**
 * @param {{
 *   limit?: 150 | 200,
 *   maxPrice?: number | null,
 *   includeAboveMaxPrice?: boolean,
 *   flagUnreliable?: boolean,
 * }} [options]
 */
export async function loadResearchExpandedPoolWithFallback(options = {}) {
  try {
    const payload = await callResearchExpandedPool(options);
    const pool = Array.isArray(payload.pool) ? payload.pool : [];
    return {
      pool,
      stats: payload.stats ?? null,
      source: "backend",
      usedStaticFallback: false,
    };
  } catch (err) {
    const limit = options.limit === 150 ? 150 : 200;
    return {
      pool: FALLBACK_RESEARCH_TICKERS.slice(0, limit),
      stats: {
        keptCount: Math.min(limit, FALLBACK_RESEARCH_TICKERS.length),
        limitApplied: limit,
        source: "static_fallback",
      },
      source: "static_fallback",
      usedStaticFallback: true,
      error: String(err?.message || err || "universe/research indisponible"),
    };
  }
}

/**
 * @param {string[]} tickers
 * @param {PreIbkrPoolMode | "strict_watchlist" | "research_expanded" | "fallback_65"} poolSource
 */
export function tagTickersForResearchExpanded(tickers, poolSource) {
  if (poolSource !== "research_expanded") {
    return tickers.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean);
  }
  return tickers
    .map((t) => String(t || "").trim().toUpperCase())
    .filter(Boolean)
    .map((symbol) => symbol);
}

/**
 * Applique les flags research sur les candidats mappés.
 * @param {unknown[]} candidates
 * @param {PreIbkrPoolMode | "strict_watchlist" | "research_expanded" | "fallback_65"} poolSource
 */
export function applyResearchExpandedFlagsToCandidates(candidates, poolSource) {
  if (poolSource !== "research_expanded" || !Array.isArray(candidates)) {
    return candidates;
  }
  return candidates.map((item) => ({
    ...item,
    researchExpanded: true,
    researchOnlyCandidate: true,
    poolSource: "research_expanded",
  }));
}

export function formatPoolSourceLabel(poolSource) {
  return PRE_IBKR_POOL_MODE_LABELS[poolSource] ?? String(poolSource || "—");
}
