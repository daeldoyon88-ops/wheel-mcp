/**
 * Seasonality Snapshot (Journal POP) — LECTURE CACHE SEULE.
 *
 * Construit un snapshot saisonnalité figé « au moment du scan » à partir
 * UNIQUEMENT du cache persistant SQLite `seasonality_cache`. Ce module :
 *   - ne fait AUCUN appel réseau / Yahoo,
 *   - n'appelle JAMAIS computeSeasonalityBundle(),
 *   - est best-effort : toute erreur ⇒ retourne null (le Journal POP s'écrit
 *     quand même, saisonnalité laissée à null).
 *
 * Le header décisionnel utilisé pour le mapping est soit lu directement depuis
 * le payload caché (`payload.decisionHeader` quand il existe), soit recalculé via
 * `buildSeasonalityDecisionHeader()` — une fonction PURE (aucun I/O, aucun réseau,
 * aucun Yahoo) opérant sur les données déjà présentes dans le cache.
 *
 * Mapping des 7 colonnes seasonality_* (voir fallbacks documentés ci-dessous) :
 *   - seasonality_score_at_scan     : weeklyScore.score (0–100), fallback annualWindowScore.score
 *   - seasonality_win_rate_at_scan  : calendarWeek.winRate, fallback fenêtre 7j (ratio décimal)
 *   - seasonality_best_window_start : début de la fenêtre annuelle active/meilleure, format « MM-DD »
 *   - seasonality_best_window_end   : fin de la fenêtre annuelle active/meilleure, format « MM-DD »
 *   - seasonality_direction         : favorable / neutre / défavorable (dérivé du score principal)
 *   - seasonality_confidence        : weeklyScore.confidence (insuffisant…robuste)
 *   - seasonality_snapshot_version  : « decision-header-v1@<computed_at du cache> »
 *
 * Note staleness : un bundle saisonnalité est une statistique annuelle/hebdo qui
 * n'évolue pas en intraday. Un cache valide mais d'un jour antérieur reste donc
 * exploitable ; sa fraîcheur est tracée via `computed_at` inclus dans la version.
 * Les entrées corrompues / logiquement invalides sont déjà purgées et renvoyées
 * `null` par `getCache()` du cache persistant.
 */

import { createSeasonalityPersistentCache } from "../seasonality/seasonalityPersistentCache.js";
import { buildSeasonalityDecisionHeader } from "../seasonality/seasonalityDecisionScores.js";

export const SEASONALITY_SNAPSHOT_VERSION = "decision-header-v1";

const NULL_SNAPSHOT = Object.freeze({
  seasonality_score_at_scan: null,
  seasonality_win_rate_at_scan: null,
  seasonality_best_window_start: null,
  seasonality_best_window_end: null,
  seasonality_direction: null,
  seasonality_confidence: null,
  seasonality_snapshot_version: null,
});

/** Snapshot « tout null » — laissé tel quel quand aucune donnée cache n'est exploitable. */
export function nullSeasonalitySnapshot() {
  return { ...NULL_SNAPSHOT };
}

let _sharedCache = null;
function resolveCache(options) {
  if (options && options.cache) return options.cache;
  if (!_sharedCache) _sharedCache = createSeasonalityPersistentCache(options?.cacheOptions ?? {});
  return _sharedCache;
}

function toNum(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Borne de fenêtre annuelle → « MM-DD » (sans année, stable). null si incomplet. */
function formatWindowEdge(month, day) {
  const m = toNum(month);
  const d = toNum(day);
  if (m == null || d == null) return null;
  return `${pad2(m)}-${pad2(d)}`;
}

/** Win rate court terme : calendrier (primaire) puis fenêtre roulante 7j (fallback). */
function readWinRate(shortTermData) {
  const cw = shortTermData?.calendarWeek ?? null;
  if (cw && typeof cw.winRate === "number" && Number.isFinite(cw.winRate)) return cw.winRate;
  const w7j = Array.isArray(shortTermData?.windows)
    ? shortTermData.windows.find((w) => w?.days === 7)
    : null;
  if (w7j && typeof w7j.winRate === "number" && Number.isFinite(w7j.winRate)) return w7j.winRate;
  return null;
}

/** Cherche la fenêtre dont le displayLabel correspond (fenêtre active du header). */
function findWindowByLabel(windowsData, label) {
  if (!windowsData || !label) return null;
  const pools = [
    windowsData.annualDisplayWindows?.bullish,
    windowsData.bestBearishAnnualWindows,
    windowsData.recentBearishVigilance,
  ];
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue;
    const hit = pool.find((w) => (w?.displayLabel ?? null) === label);
    if (hit) return hit;
  }
  return null;
}

/** Fallback : meilleure fenêtre annuelle disponible (bullish d'abord, puis bearish). */
function firstAvailableWindow(windowsData) {
  const bullish = windowsData?.annualDisplayWindows?.bullish;
  if (Array.isArray(bullish) && bullish.length) return bullish[0];
  const bearish = windowsData?.bestBearishAnnualWindows;
  if (Array.isArray(bearish) && bearish.length) return bearish[0];
  return null;
}

/** Direction lisible dérivée du score principal 0–100. null si score absent. */
function deriveDirection(score) {
  if (score == null) return null;
  if (score >= 65) return "favorable";
  if (score >= 45) return "neutre";
  return "défavorable";
}

/**
 * Contexte court lisible (V2) — combine la fenêtre annuelle active et le label
 * du score court terme. null si rien d'exploitable. Aucune invention :
 * uniquement des libellés dérivés des scores déjà calculés.
 */
function buildContextText(weekly, annual, hasActiveAnnual) {
  let annualPart = null;
  if (hasActiveAnnual) {
    const type = annual?.activeWindow?.type ?? null;
    if (type === "bullish") annualPart = "Fenêtre annuelle favorable";
    else if (type === "vigilance" || type === "bearish") annualPart = "Fenêtre annuelle défavorable";
    else annualPart = "Fenêtre annuelle active";
  }
  const rawLabel = typeof weekly?.label === "string" ? weekly.label.trim().toLowerCase() : null;
  const weeklyPart =
    rawLabel && rawLabel !== "données insuffisantes" ? `score court terme ${rawLabel}` : null;

  const parts = [];
  if (annualPart) parts.push(annualPart);
  else if (weeklyPart) parts.push("Aucune fenêtre annuelle active");
  if (weeklyPart) parts.push(weeklyPart);

  if (!parts.length) return null;
  const joined = parts.join(", ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)}.`;
}

/**
 * Construit un snapshot à partir d'un payload bundle déjà mis en cache.
 * Fonction pure (aucun I/O) — exportée pour les tests unitaires.
 *
 * @param {object|null} payload  bundle caché { shortTermData, windowsData, decisionHeader? }
 * @param {{ computedAt?: string|null, today?: Date }} [meta]
 * @returns {object|null} les 7 champs seasonality_*, ou null si rien d'exploitable.
 */
export function buildSnapshotFromBundle(payload, meta = {}) {
  if (!payload || typeof payload !== "object") return null;

  const shortTermData = payload.shortTermData ?? null;
  const windowsData = payload.windowsData ?? null;

  // decisionHeader : utilisé tel quel si caché et complet, sinon recalcul PUR.
  let header = payload.decisionHeader ?? null;
  if (!header || !header.weeklyScore) {
    try {
      header = buildSeasonalityDecisionHeader({ shortTermData, windowsData, today: meta.today });
    } catch (_) {
      header = null;
    }
  }

  const weekly = header?.weeklyScore ?? null;
  const annual = header?.annualWindowScore ?? null;

  // annualWindowScore renvoie un score « neutre » de 50 par défaut MÊME sans
  // donnée. On ne l'utilise comme fallback que s'il existe une fenêtre active
  // réelle, sinon on n'invente pas de score.
  const weeklyScore = toNum(weekly?.score);
  const hasActiveAnnual = annual?.activeWindow != null;
  const annualScore = hasActiveAnnual ? toNum(annual?.score) : null;
  const score = weeklyScore ?? annualScore;
  const winRate = readWinRate(shortTermData);
  const confidence =
    weeklyScore != null
      ? weekly?.confidence ?? null
      : hasActiveAnnual
        ? annual?.confidence ?? null
        : null;

  // Fenêtre annuelle active (par displayLabel) ou meilleure fenêtre en fallback.
  const activeLabel = annual?.activeWindow?.displayLabel ?? null;
  const window = findWindowByLabel(windowsData, activeLabel) ?? firstAvailableWindow(windowsData);
  const bestStart = window ? formatWindowEdge(window.startMonth, window.startDay) : null;
  const bestEnd = window ? formatWindowEdge(window.endMonth, window.endDay) : null;

  const direction = deriveDirection(score);

  // Aucun champ exploitable ⇒ snapshot considéré comme absent (null partout).
  if (score == null && winRate == null && bestStart == null && confidence == null) {
    return null;
  }

  const computedAt = meta.computedAt ?? null;
  const version = computedAt
    ? `${SEASONALITY_SNAPSHOT_VERSION}@${computedAt}`
    : SEASONALITY_SNAPSHOT_VERSION;

  // ── Champs V2 (audit Journal POP) ─────────────────────────────────────────
  // Décomposent les scores affichés dans l'analyse décisionnelle. Les anciens
  // champs (ci-dessus) restent INCHANGÉS pour ne pas casser les audits existants.
  // Tout champ absent du header ⇒ null (jamais inventé).
  const csp = header?.cspScore ?? null;
  const cc = header?.ccScore ?? null;
  const verdict = header?.wheelVerdict ?? null;
  const annualLabel = annual?.activeWindow?.displayLabel ?? null;
  const annualWinRate = hasActiveAnnual ? toNum(annual?.activeWindow?.winRateAnnual) : null;

  return {
    // ── Champs legacy (inchangés) ───────────────────────────────────────────
    seasonality_score_at_scan: score,
    seasonality_win_rate_at_scan: winRate,
    seasonality_best_window_start: bestStart,
    seasonality_best_window_end: bestEnd,
    seasonality_direction: direction,
    seasonality_confidence: confidence,
    seasonality_snapshot_version: version,
    // ── Champs V2 (nouveaux, nullable) ──────────────────────────────────────
    seasonality_weekly_score_at_scan: weeklyScore,
    seasonality_weekly_win_rate_at_scan: winRate,
    seasonality_annual_score_at_scan: annualScore,
    seasonality_annual_win_rate_at_scan: annualWinRate,
    seasonality_annual_window_label_at_scan: annualLabel,
    seasonality_csp_score_at_scan: toNum(csp?.score),
    seasonality_cc_score_at_scan: toNum(cc?.score),
    seasonality_wheel_verdict_at_scan: verdict?.label ?? null,
    seasonality_context_at_scan: buildContextText(weekly, annual, hasActiveAnnual),
  };
}

/**
 * Lit le cache SQLite `seasonality_cache` pour `symbol` et retourne un snapshot
 * saisonnalité, ou null si : cache absent, corrompu, logiquement invalide, ou
 * incomplet. Best-effort — ne jette jamais. Aucun appel Yahoo, aucun calcul live.
 *
 * @param {string} symbol
 * @param {{ cache?: object, cacheOptions?: object, today?: Date }} [options]
 * @returns {object|null}
 */
export function buildSeasonalitySnapshotFromCache(symbol, options = {}) {
  try {
    const sym = String(symbol ?? "").trim().toUpperCase();
    if (!sym) return null;
    const cache = resolveCache(options);
    // getCache() renvoie null si absent / corrompu / invalide (et purge l'entrée).
    const entry = cache.getCache(sym);
    if (!entry || !entry.payload) return null;
    return buildSnapshotFromBundle(entry.payload, {
      computedAt: entry.computedAt ?? null,
      today: options.today,
    });
  } catch (_) {
    return null;
  }
}
