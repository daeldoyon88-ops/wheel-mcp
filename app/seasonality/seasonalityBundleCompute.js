/**
 * Seasonality Bundle Compute — calcul + persistance réutilisable (CLI / routes).
 *
 * Extrait la logique de computeSeasonalityBundle() depuis seasonalityRoutes.js
 * pour permettre un fetch Yahoo contrôlé hors HTTP (ex. backfill Journal CLI).
 *
 * Ne touche pas au scanner, IBKR, POP, ni aux routes elles-mêmes.
 */

import {
  computeSeasonalityCalendar,
  computeSeasonalityShortTerm,
  computeSeasonalityWindows,
} from "./seasonalityEngine.js";
import {
  computeSeasonalityChart3y,
  buildChart3yApiResponse,
} from "./seasonalityChart3y.js";
import {
  createSeasonalityPersistentCache,
} from "./seasonalityPersistentCache.js";
import { analyzeBundlePayload } from "./seasonalityBundleValidation.js";
import { buildSeasonalityDecisionHeader } from "./seasonalityDecisionScores.js";

/**
 * Calcule decisionHeader depuis un payload bundle (fonction pure, sans I/O).
 * @param {object|null} payload
 * @returns {object|null}
 */
export function computeDecisionHeaderFromPayload(payload) {
  try {
    return buildSeasonalityDecisionHeader({
      shortTermData: payload?.shortTermData,
      windowsData: payload?.windowsData,
    });
  } catch (_) {
    return null;
  }
}

/**
 * Calcule le bundle saisonnalité complet pour un ticker (4 sources + decisionHeader).
 * Appels Yahoo via seasonalityEngine — aucune persistance.
 *
 * @param {string} ticker
 * @returns {Promise<object>}
 */
export async function computeSeasonalityBundleForTicker(ticker) {
  const sym = String(ticker ?? "").trim().toUpperCase();
  const [calendar, shortTerm, windows, chart3yRaw] = await Promise.all([
    computeSeasonalityCalendar(sym),
    computeSeasonalityShortTerm(sym),
    computeSeasonalityWindows(sym),
    computeSeasonalityChart3y(sym),
  ]);
  const partialPayload = {
    calendarData: calendar ?? null,
    shortTermData: shortTerm ?? null,
    windowsData: windows ?? null,
    chart3yData: buildChart3yApiResponse(chart3yRaw),
  };
  return {
    ok: true,
    ticker: sym,
    ...partialPayload,
    decisionHeader: computeDecisionHeaderFromPayload(partialPayload),
  };
}

/**
 * Calcule le bundle, valide le payload, et persiste dans seasonality_cache si valide.
 *
 * @param {string} symbol
 * @param {object} [options]
 * @param {object} [options.cache]          cache persistant injecté (tests).
 * @param {object} [options.cacheOptions]   options createSeasonalityPersistentCache.
 * @returns {Promise<{ ok: boolean, symbol: string, persisted?: boolean, error?: string, analysis?: object }>}
 */
export async function computeAndPersistSeasonalityBundle(symbol, options = {}) {
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) {
    return { ok: false, symbol: sym, error: "invalid_symbol" };
  }

  const cache =
    options.cache ?? createSeasonalityPersistentCache(options.cacheOptions ?? {});
  await cache.ensureInitialized();

  let bundle;
  try {
    bundle = await computeSeasonalityBundleForTicker(sym);
  } catch (error) {
    return {
      ok: false,
      symbol: sym,
      error: String(error?.message ?? error ?? "bundle_compute_failed"),
    };
  }

  const payload = {
    calendarData: bundle.calendarData ?? null,
    shortTermData: bundle.shortTermData ?? null,
    windowsData: bundle.windowsData ?? null,
    chart3yData: bundle.chart3yData ?? null,
    decisionHeader: bundle.decisionHeader ?? computeDecisionHeaderFromPayload(bundle),
  };

  const analysis = analyzeBundlePayload(payload);
  if (!analysis.validBundle) {
    return { ok: false, symbol: sym, error: "invalid_bundle", analysis };
  }

  const persisted = cache.setCache(sym, payload);
  if (!persisted) {
    return { ok: false, symbol: sym, error: "cache_set_failed", analysis };
  }

  return { ok: true, symbol: sym, persisted: true, analysis };
}
