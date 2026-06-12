/**
 * Calendrier marché US (actions/options) — gestion des expirations tombant
 * un jour de marché fermé (week-end ou férié connu).
 *
 * Règle métier (demandée par l'utilisateur) :
 *  - Vendredi fermé  → utiliser le jeudi précédent (date - 1 jour).
 *  - Lundi fermé     → utiliser le mardi suivant   (date + 1 jour).
 *  - Ne JAMAIS basculer un vendredi fermé vers le lundi suivant.
 *  - Ne JAMAIS basculer un lundi fermé vers le vendredi précédent.
 *  - Autre jour fermé → prochaine date ouverte disponible, avec avertissement.
 *
 * Module pur (aucune dépendance React/DOM) pour rester testable via node --test.
 */
import { normalizeExpirationKey } from "./expirationKey.js";

/** Jours fériés US 2026 — marché actions/options fermé. Source: liste utilisateur. */
export const US_MARKET_HOLIDAYS_2026 = Object.freeze({
  "2026-01-01": "New Year's Day",
  "2026-01-19": "Martin Luther King Jr. Day",
  "2026-02-16": "Washington's Birthday",
  "2026-04-03": "Good Friday",
  "2026-05-25": "Memorial Day",
  "2026-06-19": "Juneteenth",
  "2026-07-03": "Independence Day (observé)",
  "2026-09-07": "Labor Day",
  "2026-11-26": "Thanksgiving",
  "2026-12-25": "Christmas",
});

/** Libellé férié pour une date YYYY-MM-DD, sinon null. */
export function getUsMarketHolidayLabel(dateString) {
  const ymd = normalizeExpirationKey(dateString);
  if (!ymd) return null;
  return US_MARKET_HOLIDAYS_2026[ymd] || null;
}

/** Jour de la semaine local (0=dimanche … 6=samedi) pour une date YYYY-MM-DD. */
function dayOfWeekYmd(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

/** Décale une date YYYY-MM-DD de deltaDays (positif ou négatif) → YYYY-MM-DD. */
function shiftYmd(ymd, deltaDays) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + deltaDays);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * True si la date (YYYY-MM-DD / YYYYMMDD) tombe un week-end ou un férié US connu.
 * @param {string} dateString
 * @returns {boolean}
 */
export function isUsMarketClosedDate(dateString) {
  const ymd = normalizeExpirationKey(dateString);
  if (!ymd) return false;
  const dow = dayOfWeekYmd(ymd);
  if (dow === 0 || dow === 6) return true; // dimanche / samedi
  return Boolean(US_MARKET_HOLIDAYS_2026[ymd]);
}

/**
 * Ajuste une expiration tombant un jour de marché US fermé.
 * @param {string} dateString expiration UI (YYYY-MM-DD / YYYYMMDD)
 * @returns {{
 *   original: string|null,
 *   adjusted: string|null,
 *   closed: boolean,
 *   holidayLabel: string|null,
 *   reason: 'open'|'friday_to_thursday'|'monday_to_tuesday'|'next_open_day'|'unresolved',
 *   blocked: boolean,
 *   warning: string|null,
 * }}
 */
export function getAdjustedExpirationForClosedMarket(dateString) {
  const ymd = normalizeExpirationKey(dateString);
  const result = {
    original: ymd,
    adjusted: ymd,
    closed: false,
    holidayLabel: null,
    reason: "open",
    blocked: false,
    warning: null,
  };
  if (!ymd || !isUsMarketClosedDate(ymd)) return result;

  result.closed = true;
  result.holidayLabel = US_MARKET_HOLIDAYS_2026[ymd] || null;
  const dow = dayOfWeekYmd(ymd);

  if (dow === 5) {
    // Vendredi fermé → jeudi précédent (jamais le lundi suivant).
    result.adjusted = shiftYmd(ymd, -1);
    result.reason = "friday_to_thursday";
  } else if (dow === 1) {
    // Lundi fermé → mardi suivant (jamais le vendredi précédent).
    result.adjusted = shiftYmd(ymd, 1);
    result.reason = "monday_to_tuesday";
  } else {
    // Autre jour fermé (week-end, mardi/mercredi/jeudi férié) :
    // avancer jusqu'à la prochaine date ouverte, avec avertissement.
    let candidate = shiftYmd(ymd, 1);
    let guard = 0;
    while (isUsMarketClosedDate(candidate) && guard < 14) {
      candidate = shiftYmd(candidate, 1);
      guard += 1;
    }
    result.adjusted = candidate;
    result.reason = "next_open_day";
    result.warning = `${ymd} est fermé : expiration reportée à ${candidate}.`;
  }

  // Garde-fou : si la date ajustée reste fermée (férié contigu) ou introuvable, bloquer.
  if (!result.adjusted || isUsMarketClosedDate(result.adjusted)) {
    result.reason = "unresolved";
    result.blocked = true;
    result.adjusted = null;
    result.warning =
      result.warning ||
      `${ymd} est fermé et aucune date d'expiration ouverte n'a pu être déterminée.`;
  }

  return result;
}

/**
 * Construit les entrées du sélecteur d'expiration.
 * Pour une expiration fermée, la VALEUR (envoyée au scan) devient la date ajustée
 * ouverte, tandis que le libellé signale la substitution. Les expirations
 * normales restent strictement inchangées (value === label === date d'origine).
 *
 * @param {string[]} expirations dates YYYY-MM-DD candidates (ex. vendredis)
 * @returns {Array<{
 *   value: string,
 *   label: string,
 *   original: string,
 *   adjusted: string|null,
 *   closed: boolean,
 *   holidayLabel: string|null,
 *   blocked: boolean,
 * }>}
 */
export function buildExpirationOptions(expirations) {
  const list = Array.isArray(expirations) ? expirations : [];
  return list
    .map((exp) => normalizeExpirationKey(exp))
    .filter(Boolean)
    .map((exp) => {
      const adj = getAdjustedExpirationForClosedMarket(exp);
      if (!adj.closed) {
        return {
          value: exp,
          label: exp,
          original: exp,
          adjusted: exp,
          closed: false,
          holidayLabel: null,
          blocked: false,
        };
      }
      const holidaySuffix = adj.holidayLabel ? ` ${adj.holidayLabel}` : "";
      if (adj.blocked || !adj.adjusted) {
        // Aucune date ouverte exploitable : on garde la date d'origine fermée et on bloque.
        return {
          value: exp,
          label: `${exp} (fermé${holidaySuffix} — indisponible)`,
          original: exp,
          adjusted: null,
          closed: true,
          holidayLabel: adj.holidayLabel,
          blocked: true,
        };
      }
      return {
        value: adj.adjusted,
        label: `${adj.adjusted} (≠ ${exp} fermé${holidaySuffix})`,
        original: exp,
        adjusted: adj.adjusted,
        closed: true,
        holidayLabel: adj.holidayLabel,
        blocked: false,
      };
    });
}
