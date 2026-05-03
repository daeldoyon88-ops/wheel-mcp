import { evaluateLiquidity } from "../calculations/wheelMetrics.js";
import { toNumber } from "../utils/number.js";

/**
 * @param {number | null | undefined} spot
 * @param {number} maxPrice
 */
export function passesMaxPrice(spot, maxPrice) {
  const s = toNumber(spot);
  if (!(s > 0)) return { ok: false, reason: "price_unavailable" };
  if (s > maxPrice) return { ok: false, reason: "above_max_price", detail: { spot: s, maxPrice } };
  return { ok: true };
}

/**
 * Prix spot minimal (prix absence → même règle que max : rejet price_unavailable).
 *
 * @param {number | null | undefined} minPrice si <= 0, filtre désactivé (aucun plancher).
 */
export function passesMinPrice(spot, minPrice) {
  const floor = toNumber(minPrice);
  if (!(floor > 0)) return { ok: true };
  const s = toNumber(spot);
  if (!(s > 0)) return { ok: false, reason: "price_unavailable" };
  if (s < floor) return { ok: false, reason: "below_min_price", detail: { spot: s, minPrice: floor } };
  return { ok: true };
}

/**
 * Priorité : moyenne 3 mois → moyenne 10 j → volume séance.
 *
 * @param {{ regularMarketVolume?: unknown, averageDailyVolume3Month?: unknown, averageDailyVolume10Day?: unknown }} quote
 * @param {number} minVolume
 */
export function passesMinVolume(quote, minVolume) {
  const a3 = toNumber(quote?.averageDailyVolume3Month);
  const a10 = toNumber(quote?.averageDailyVolume10Day);
  const rm = toNumber(quote?.regularMarketVolume);
  const vol = (a3 > 0 ? a3 : null) ?? (a10 > 0 ? a10 : null) ?? (rm > 0 ? rm : null);
  if (vol == null || !(vol > 0)) {
    return { ok: false, reason: "volume_unavailable" };
  }
  if (vol < minVolume) {
    return { ok: false, reason: "below_min_volume", detail: { volume: vol, minVolume } };
  }
  return { ok: true, detail: { volumeUsed: vol } };
}

/**
 * Capital nominal d’un contrat CSP (100 actions) : rejette si spot * 100 > plafond.
 * Si maxContractCapital est absent, ≤ 0 ou non fini → filtre inactif (ok).
 *
 * @param {number | null | undefined} spot
 * @param {number | null | undefined} maxContractCapital
 */
export function passesMaxContractCapital(spot, maxContractCapital) {
  const cap = toNumber(maxContractCapital);
  if (!(cap > 0)) return { ok: true };
  const s = toNumber(spot);
  if (!(s > 0)) return { ok: false, reason: "price_unavailable" };
  const contractCapital = s * 100;
  if (contractCapital > cap) {
    return {
      ok: false,
      reason: "contract_capital_above_max",
      detail: { spot: s, contractCapital, maxContractCapital: cap },
    };
  }
  return { ok: true };
}

/**
 * Détecte une chaîne "style hebdo" : au moins deux expirations futures dont l’écart est typique d’un cycle court (4–10 jours).
 *
 * @param {string[]} expirationIsoDates YYYY-MM-DD
 * @param {string} todayIso YYYY-MM-DD
 */
export function hasWeeklyStyleExpirations(expirationIsoDates, todayIso) {
  if (!Array.isArray(expirationIsoDates) || expirationIsoDates.length < 2) return false;

  const future = expirationIsoDates
    .filter((d) => typeof d === "string" && d.length >= 10)
    .map((d) => d.slice(0, 10))
    .filter((d) => d >= todayIso)
    .sort();

  if (future.length < 2) return false;

  for (let i = 0; i < future.length - 1; i += 1) {
    const days = calendarDayDiff(future[i], future[i + 1]);
    if (days >= 4 && days <= 10) return true;
  }
  return false;
}

/**
 * @param {string} a YYYY-MM-DD
 * @param {string} b YYYY-MM-DD
 */
function calendarDayDiff(a, b) {
  const da = new Date(`${a}T12:00:00.000Z`);
  const db = new Date(`${b}T12:00:00.000Z`);
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Trouve le put dont le strike est le plus proche du spot et applique evaluateLiquidity (règles wheelMetrics).
 *
 * @param {{ puts?: unknown[], currentPrice?: unknown }} chain
 * @param {number} spot
 */
export function evaluateAtmPutLiquidity(chain, spot) {
  const puts = Array.isArray(chain?.puts) ? chain.puts : [];
  if (!puts.length) return { ok: false, reason: "no_puts" };

  const s = toNumber(spot);
  if (!(s > 0)) return { ok: false, reason: "spot_unavailable" };

  let best = null;
  let bestDist = Infinity;
  for (const row of puts) {
    const strike = toNumber(row?.strike);
    if (!(strike > 0)) continue;
    const d = Math.abs(strike - s);
    if (d < bestDist) {
      bestDist = d;
      best = row;
    }
  }

  if (!best) return { ok: false, reason: "no_put_near_spot" };

  const liq = evaluateLiquidity(best);
  if (liq?.isLiquid) return { ok: true, detail: { strike: toNumber(best.strike), liquidity: liq } };

  return {
    ok: false,
    reason: "atm_put_not_liquid",
    detail: { strike: toNumber(best.strike), liquidity: liq },
  };
}
