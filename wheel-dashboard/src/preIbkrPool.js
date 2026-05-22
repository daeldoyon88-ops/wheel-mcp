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
 * @returns {{ tickers: string[], poolSource: PreIbkrPoolMode | "strict_watchlist" | "research_expanded" | "fallback_65" | "unknown", requestedMode: PreIbkrPoolMode | "unknown", usedFallbackUltimate: boolean }}
 */
export function resolvePreIbkrTickers({
  watchlistTickers,
  preIbkrPoolMode,
  researchExpandedPool,
  researchExpandedLimit,
  fallbackTickers,
}) {
  const mode = preIbkrPoolMode || "strict_watchlist";

  if (mode === "strict_watchlist") {
    const tickers = Array.isArray(watchlistTickers) ? watchlistTickers : [];
    return {
      tickers,
      poolSource: "strict_watchlist",
      requestedMode: mode,
      usedFallbackUltimate: false,
    };
  }

  if (mode === "research_expanded") {
    const limit = Math.max(1, Number(researchExpandedLimit) || 150);
    const pool = (Array.isArray(researchExpandedPool) ? researchExpandedPool : [])
      .map((t) => String(t || "").trim().toUpperCase())
      .filter(Boolean);
    const tickers = [...new Set(pool)].slice(0, limit);

    return {
      tickers,
      poolSource: "research_expanded",
      requestedMode: mode,
      usedFallbackUltimate: false,
    };
  }

  if (mode === "fallback_65") {
    const tickers = Array.isArray(fallbackTickers) ? fallbackTickers : [];
    return {
      tickers,
      poolSource: "fallback_65",
      requestedMode: mode,
      usedFallbackUltimate: true,
    };
  }

  return {
    tickers: [],
    poolSource: "unknown",
    requestedMode: mode,
    usedFallbackUltimate: false,
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

/**
 * Message informatif quand la Strict Watchlist est vide mais un autre pool pré-IBKR est actif.
 * @param {{
 *   poolSource: PreIbkrPoolMode | "strict_watchlist" | "research_expanded" | "fallback_65",
 *   tickersCount: number,
 *   usedFallbackUltimate: boolean,
 * }} params
 */
export function buildStrictWatchlistEmptyInfo({ poolSource, tickersCount, usedFallbackUltimate }) {
  if (poolSource === "research_expanded") {
    if (usedFallbackUltimate) {
      return "Strict Watchlist vide — pool Research Expanded indisponible, secours fallback 65 utilisé.";
    }
    return tickersCount > 0
      ? "Strict Watchlist vide — scan basé sur Research Expanded."
      : "Strict Watchlist vide — Research Expanded actif mais pool vide.";
  }
  if (poolSource === "fallback_65") {
    return "Strict Watchlist vide — scan basé sur fallback 65 (secours). IBKR Audit Depth ne pourra pas dépasser ~65.";
  }
  return "Strict Watchlist vide — mode Strict Watchlist actif, aucun ticker pré-IBKR.";
}

/**
 * Message quand IBKR auto est sauté après une tentative Yahoo réelle (ou cache).
 * @param {{
 *   poolSource: PreIbkrPoolMode | "strict_watchlist" | "research_expanded" | "fallback_65",
 *   preIbkrCount: number,
 *   fromCache?: boolean,
 * }} params
 */
export function buildIbkrAutoSkipMessage({ poolSource, preIbkrCount, fromCache = false }) {
  const cacheSuffix = fromCache ? " (cache)" : "";
  if (poolSource === "research_expanded" && preIbkrCount > 0) {
    return `Research Expanded n'a retourné aucun candidat Yahoo exploitable${cacheSuffix} — IBKR auto non lancé.`;
  }
  if (poolSource === "fallback_65" && preIbkrCount > 0) {
    return `Fallback 65 : aucun candidat Yahoo exploitable${cacheSuffix} — IBKR auto non lancé.`;
  }
  if (fromCache) {
    return "Yahoo shortlist vide (cache) — IBKR auto non lancé. Vérifier rejets Yahoo.";
  }
  return "Yahoo shortlist vide — IBKR auto non lancé. Vérifier rejets Yahoo.";
}

/**
 * Message quand IBKR auto ne peut pas démarrer faute de pool pré-Yahoo ou d'erreur réseau.
 * @param {{
 *   poolSource: PreIbkrPoolMode | "strict_watchlist" | "research_expanded" | "fallback_65",
 *   preIbkrCount: number,
 *   hasCache: boolean,
 * }} params
 */
export function buildIbkrAutoNetworkSkipMessage({ poolSource, preIbkrCount, hasCache }) {
  if (hasCache) {
    return buildIbkrAutoSkipMessage({ poolSource, preIbkrCount, fromCache: true });
  }
  if (preIbkrCount === 0) {
    if (poolSource === "strict_watchlist") {
      return "IBKR auto non lancé : Strict Watchlist vide, aucun ticker pré-Yahoo.";
    }
    if (poolSource === "research_expanded") {
      return "IBKR auto non lancé : pool Research Expanded vide, aucun ticker pré-Yahoo.";
    }
    return "IBKR auto non lancé : pool pré-Yahoo vide. Pas de fallback watchlist.";
  }
  return "IBKR auto non lancé : pas de shortlist Yahoo (erreur réseau / pas de cache). Pas de fallback watchlist.";
}
