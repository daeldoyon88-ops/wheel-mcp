import {
  MAX_ABSOLUTE_SPREAD,
  PREMIUM_TOLERANCE,
  WEEKLY_TARGET_PCT,
} from "../config/constants.js";
import { round, roundMoney, toNumber } from "../utils/number.js";

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

export function getDteDays(expiration) {
  const now = new Date();
  const exp = new Date(`${expiration}T00:00:00`);
  const diff = exp - now;
  return Math.max(1, Math.round(diff / (1000 * 60 * 60 * 24)));
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
  if (!(bid > 0 && ask > 0)) return null;
  const mid = (bid + ask) / 2;
  if (mid <= 0) return null;
  return ((ask - bid) / mid) * 100;
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
  const spreadPctOk = spreadPct == null ? true : spreadPct <= maxSpreadPct;

  return {
    isTradable: hasRealMarket && absoluteSpreadOk && spreadPctOk,
    spreadPct: spreadPct != null ? round(spreadPct, 2) : null,
    absoluteSpread: absoluteSpread != null ? round(absoluteSpread, 3) : null,
    volume,
    openInterest,
    checks: {
      hasRealMarket,
      hasLastFallback,
      absoluteSpreadOk,
      spreadPctOk,
      rejectReason: hasRealMarket ? null : "no_real_bid_ask",
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
  const spreadPctOk = spreadPct == null ? true : spreadPct <= maxSpreadPct;
  const volumeOk = volume >= 1;
  // Baseline souple : le seuil final est renforcé ensuite dans selectPutStrikes
  // selon la profondeur du strike par rapport à l'agressif.
  const openInterestOk = openInterest >= 5;
  const hasBookQuality = absoluteSpreadOk && spreadPctOk && volumeOk && openInterestOk;

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
      spreadPctOk,
      volumeOk,
      openInterestOk,
      rejectReason: hasRealMarket ? null : "no_real_bid_ask",
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
