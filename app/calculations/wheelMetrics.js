import {
  MAX_ABSOLUTE_SPREAD,
  PREMIUM_TOLERANCE,
  WEEKLY_TARGET_PCT,
} from "../config/constants.js";
import { round, roundMoney, toNumber } from "../utils/number.js";

export const WHEEL_MARKET_TIME_ZONE = "America/New_York";
const CALENDAR_DAY_MS = 24 * 60 * 60 * 1000;

function normalizeCalendarParts(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) return null;
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day, ordinal: date.getTime() };
}

function parseCalendarDateString(value) {
  if (typeof value !== "string") return { matched: false, parts: null };
  const raw = value.trim();
  const dashed = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  const match = dashed ?? compact;
  if (!match) return { matched: false, parts: null };
  return {
    matched: true,
    parts: normalizeCalendarParts(Number(match[1]), Number(match[2]), Number(match[3])),
  };
}

function calendarPartsFor(value, timeZone) {
  const parsedCalendar = parseCalendarDateString(value);
  if (parsedCalendar.matched) return parsedCalendar.parts;

  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(instant);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return normalizeCalendarParts(
      Number(byType.year),
      Number(byType.month),
      Number(byType.day),
    );
  } catch (_error) {
    return null;
  }
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * Différence entre deux dates civiles dans le fuseau du marché.
 * Retourne 0 le même jour, un entier négatif pour une expiration passée,
 * et null lorsqu'une date ou le fuseau est invalide.
 */
export function getCalendarDte({
  asOfDate = new Date(),
  expirationDate,
  timeZone = WHEEL_MARKET_TIME_ZONE,
} = {}) {
  if (!isValidTimeZone(timeZone)) return null;
  const asOf = calendarPartsFor(asOfDate, timeZone);
  const expiration = calendarPartsFor(expirationDate, timeZone);
  if (!asOf || !expiration) return null;
  return (expiration.ordinal - asOf.ordinal) / CALENDAR_DAY_MS;
}

export function getTargetWeeks(dteDays) {
  if (!dteDays || dteDays <= 0) return 1;
  return Math.max(1, Math.ceil(dteDays / 7));
}

export function minPremiumForSpot(spot, dteDays) {
  if (!spot || spot <= 0) return 0;
  const targetWeeks = Math.max(1, dteDays / 7);
  return spot * (WEEKLY_TARGET_PCT / 100) * targetWeeks;
}

export function premiumMeetsTarget(premium, targetPremium) {
  const premiumRounded = roundMoney(toNumber(premium));
  const targetRounded = roundMoney(toNumber(targetPremium));
  if (premiumRounded >= targetRounded) return true;
  if (premiumRounded >= roundMoney(targetRounded - PREMIUM_TOLERANCE)) return true;
  return false;
}

export function weeklyYieldDecimal(premium, strike, dteDays) {
  if (!premium || !strike) return 0;
  return premium / strike;
}

export function strikeDistancePct(strike, spot) {
  if (!strike || !spot || spot <= 0) return 0;
  return ((strike - spot) / spot) * 100;
}

export function getDteDays(
  expiration,
  asOfDate = new Date(),
  timeZone = WHEEL_MARKET_TIME_ZONE,
) {
  const calendarDte = getCalendarDte({ asOfDate, expirationDate: expiration, timeZone });
  return calendarDte == null ? Number.NaN : Math.max(1, calendarDte);
}

export function pickReliablePremium(row, strictBidAsk = false) {
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  const explicitMid = toNumber(row?.mid);
  const last = toNumber(row?.lastPrice);
  if (strictBidAsk) {
    if (bid > 0 && ask > 0) return (bid + ask) / 2;
    return 0;
  }
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  if (explicitMid > 0) return explicitMid;
  if (bid > 0 && last > 0) return (bid + last) / 2;
  if (ask > 0 && last > 0) return (ask + last) / 2;
  if (last > 0) return last;
  if (bid > 0) return bid;
  if (ask > 0) return ask;
  return 0;
}

export function getConservativePremium(row) {
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  const mid = pickReliablePremium(row);
  if (bid > 0) return bid;
  if (bid <= 0 && ask > 0) return Math.min(mid, ask);
  return mid;
}

export function computeSpreadPct(row) {
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  if (!(Number.isFinite(bid) && Number.isFinite(ask) && bid >= 0 && ask >= 0)) return null;
  if (bid > ask) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  if (bid === ask) return 0;
  return ((ask - bid) / mid) * 100;
}

export function spreadPctOk(spreadPct, maxSpreadPct) {
  return (
    Number.isFinite(spreadPct) &&
    spreadPct >= 0 &&
    spreadPct <= maxSpreadPct
  );
}

export function computeAbsoluteSpread(row) {
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  if (!(bid > 0 && ask > 0)) return null;
  return ask - bid;
}

function dynamicMaxSpreadPctFromBid(bid) {
  return bid < 1 ? 50 : 20;
}

export function evaluateTradability(row) {
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  const last = toNumber(row?.lastPrice);
  const volume = toNumber(row?.volume);
  const openInterest = toNumber(row?.openInterest);
  const spreadPct = computeSpreadPct(row);
  const absoluteSpread = computeAbsoluteSpread(row);
  const hasRealMarket = bid > 0 && ask > 0;
  const hasLastFallback = last > 0 && volume >= 10 && openInterest >= 100;
  const absoluteSpreadOk = absoluteSpread == null ? true : absoluteSpread <= MAX_ABSOLUTE_SPREAD;
  const maxSpreadPct = dynamicMaxSpreadPctFromBid(bid);
  const spreadPctOkCheck = spreadPct == null ? true : spreadPctOk(spreadPct, maxSpreadPct);
  const crossedMarket = Number.isFinite(bid) && Number.isFinite(ask) && bid > ask;

  return {
    isTradable: hasRealMarket && absoluteSpreadOk && spreadPctOkCheck,
    spreadPct: spreadPct != null ? round(spreadPct, 2) : null,
    absoluteSpread: absoluteSpread != null ? round(absoluteSpread, 3) : null,
    volume,
    openInterest,
    checks: {
      hasRealMarket,
      hasLastFallback,
      absoluteSpreadOk,
      spreadPctOk: spreadPctOkCheck,
      rejectReason: crossedMarket
        ? "CROSSED_MARKET"
        : spreadPct != null && spreadPct < 0
          ? "NEGATIVE_SPREAD_PCT"
          : hasRealMarket
            ? null
            : "no_real_bid_ask",
    },
  };
}

export function evaluateLiquidity(row) {
  const bid = toNumber(row?.bid);
  const ask = toNumber(row?.ask);
  const last = toNumber(row?.lastPrice);
  const volume = toNumber(row?.volume);
  const openInterest = toNumber(row?.openInterest);
  const spreadPct = computeSpreadPct(row);
  const absoluteSpread = computeAbsoluteSpread(row);
  const hasRealMarket = bid > 0 && ask > 0;
  const hasLastFallback = last > 0 && volume >= 10 && openInterest >= 100;
  const absoluteSpreadOk = absoluteSpread == null ? true : absoluteSpread <= MAX_ABSOLUTE_SPREAD;
  const maxSpreadPct = dynamicMaxSpreadPctFromBid(bid);
  const spreadPctOkCheck = spreadPct == null ? true : spreadPctOk(spreadPct, maxSpreadPct);
  const crossedMarket = Number.isFinite(bid) && Number.isFinite(ask) && bid > ask;
  const volumeOk = volume >= 1;
  // Baseline souple : le seuil final est renforcé ensuite dans selectPutStrikes
  // selon la profondeur du strike par rapport à l'agressif.
  const openInterestOk = openInterest >= 5;
  const hasBookQuality = absoluteSpreadOk && spreadPctOkCheck && volumeOk && openInterestOk;

  return {
    isLiquid: hasRealMarket && hasBookQuality,
    spreadPct: spreadPct != null ? round(spreadPct, 2) : null,
    absoluteSpread: absoluteSpread != null ? round(absoluteSpread, 3) : null,
    volume,
    openInterest,
    checks: {
      hasRealMarket,
      hasLastFallback,
      absoluteSpreadOk,
      spreadPctOk: spreadPctOkCheck,
      volumeOk,
      openInterestOk,
      rejectReason: crossedMarket
        ? "CROSSED_MARKET"
        : spreadPct != null && spreadPct < 0
          ? "NEGATIVE_SPREAD_PCT"
          : hasRealMarket
            ? null
            : "no_real_bid_ask",
    },
  };
}

function minOpenInterestForAggressive() {
  return 25;
}

function minOpenInterestForSafe(put, aggressiveStrike) {
  if (!aggressiveStrike?.strike || !put?.strike) return 50;
  const depthPct = ((aggressiveStrike.strike - put.strike) / aggressiveStrike.strike) * 100;
  // Proche de l'agressif: strict. Plus profond: plus souple.
  return depthPct < 1 ? 50 : 15;
}

function normalizePutForSelection(put, spot, targetPremium) {
  const strike = toNumber(put?.strike);
  const premium = pickReliablePremium(put);
  const conservativePremium = getConservativePremium(put);
  const tradability = evaluateTradability(put);
  const liquidity = evaluateLiquidity(put);

  return {
    strike,
    bid: toNumber(put?.bid),
    ask: toNumber(put?.ask),
    lastPrice: toNumber(put?.lastPrice),
    mid: premium,
    conservativePremium,
    volume: toNumber(put?.volume),
    openInterest: toNumber(put?.openInterest),
    impliedVolatility: toNumber(put?.impliedVolatility),
    tradability,
    liquidity,
    targetPremium,
    qualifiesTarget: premiumMeetsTarget(conservativePremium, targetPremium),
    distancePct: strikeDistancePct(strike, spot),
  };
}

export function selectPutStrikes({ puts, spot, lowerBoundForSelection, dteDays }) {
  const targetPremium = minPremiumForSpot(spot, dteDays);
  const normalizedPuts = (puts || []).map((put) => normalizePutForSelection(put, spot, targetPremium));
  const eligible = normalizedPuts
    .filter((put) => put.strike > 0)
    .filter((put) => put.strike < lowerBoundForSelection)
    .sort((a, b) => a.strike - b.strike);

  const tradableEligible = eligible.filter((put) => put.tradability?.isTradable);
  const liquidEligible = eligible.filter((put) => put.liquidity?.isLiquid);
  const liquidEligibleAtOrAboveTarget = liquidEligible.filter((put) =>
    premiumMeetsTarget(put.conservativePremium, targetPremium)
  );
  const aggressiveEligible = liquidEligibleAtOrAboveTarget.filter(
    (put) => toNumber(put.openInterest) >= minOpenInterestForAggressive()
  );

  const aggressiveStrike =
    aggressiveEligible.length > 0
      ? [...aggressiveEligible].sort((a, b) => b.strike - a.strike)[0]
      : null;

  const safeCandidatesBelowAggressive =
    aggressiveStrike == null
      ? []
      : liquidEligibleAtOrAboveTarget
          .filter((put) => put.strike < aggressiveStrike.strike)
          .filter((put) => toNumber(put.openInterest) >= minOpenInterestForSafe(put, aggressiveStrike))
          .sort((a, b) => b.strike - a.strike);

  const safeStrike =
    aggressiveStrike == null
      ? null
      : safeCandidatesBelowAggressive.length > 0
        ? safeCandidatesBelowAggressive[0]
        : aggressiveStrike;

  const diagnosticsPutsBelowAggressive = aggressiveStrike
    ? normalizedPuts
        .filter((put) => put.strike > 0 && put.strike < aggressiveStrike.strike)
        .sort((a, b) => b.strike - a.strike)
        .slice(0, 10)
        .map((put) => {
          const isBelowLowerBound = put.strike < lowerBoundForSelection;
          const meetsTargetPremium = premiumMeetsTarget(put.conservativePremium, targetPremium);
          const liquidityOk = !!put?.liquidity?.isLiquid;
          const spreadOk = !!(
            put?.liquidity?.checks?.absoluteSpreadOk && put?.liquidity?.checks?.spreadPctOk
          );
          const oiRequired = minOpenInterestForSafe(put, aggressiveStrike);
          const oiOk = toNumber(put.openInterest) >= oiRequired;
          const finalValid =
            isBelowLowerBound && meetsTargetPremium && liquidityOk && spreadOk && oiOk;
          const rejectReasons = [];
          if (!isBelowLowerBound) rejectReasons.push("not_below_lower_bound");
          if (!meetsTargetPremium) rejectReasons.push("premium_below_target");
          if (!liquidityOk) rejectReasons.push("liquidity_not_ok");
          if (!spreadOk) rejectReasons.push("spread_not_ok");
          if (!oiOk) rejectReasons.push("open_interest_below_safe_threshold");
          return {
            strike: put.strike,
            bid: put.bid,
            ask: put.ask,
            lastPrice: put.lastPrice,
            mid: put.mid,
            spread: put?.liquidity?.absoluteSpread ?? null,
            spreadPct: put?.liquidity?.spreadPct ?? null,
            volume: put.volume,
            openInterest: put.openInterest,
            premiumUsed: put.conservativePremium,
            meetsTargetPremium,
            isBelowLowerBound,
            liquidityOk,
            spreadOk,
            finalValid,
            rejectReason: rejectReasons.length ? rejectReasons.join("|") : null,
          };
        })
    : [];

  return {
    targetPremium,
    eligible,
    tradableEligible,
    liquidEligible,
    safeCandidates: safeCandidatesBelowAggressive,
    safeStrike,
    aggressiveStrike,
    diagnosticsPutsBelowAggressive,
    safeSelectionMode: safeStrike
      ? safeCandidatesBelowAggressive.length > 0
        ? "first_liquid_strike_below_aggressive_meeting_target"
        : "fallback_to_aggressive_no_lower_strike_meeting_target"
      : "none",
  };
}
