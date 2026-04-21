import { EARNINGS_SYMBOLS, MAX_SCAN_TICKERS } from "../config/constants.js";
import {
  getDteDays,
  getTargetWeeks,
  premiumMeetsTarget,
  selectPutStrikes,
  weeklyYieldDecimal,
} from "../calculations/wheelMetrics.js";
import { round, roundMoney, toNumber } from "../utils/number.js";

const STRIKE_DEBUG_SYMBOLS = new Set(["HOOD", "UBER", "SOFI", "U", "TQQQ"]);

export function createWheelScanner(marketService) {
  async function scanTicker(symbol, expiration) {
    const expirations = await marketService.getOptionExpirations(symbol);
    if (!expirations.availableExpirations.includes(expiration)) {
      return { symbol, ok: false, reason: "expiration_not_available" };
    }

    const [quote, expectedMove, optionChain, technicals, supportResistance] = await Promise.all([
      marketService.getQuote(symbol),
      marketService.getExpectedMove(symbol, expiration),
      marketService.getOptionChain(symbol, expiration),
      marketService.getTechnicals(symbol),
      marketService.getSupportResistance(symbol),
    ]);

    const spot =
      toNumber(quote?.regularMarketPrice) ||
      toNumber(optionChain?.currentPrice) ||
      toNumber(expectedMove?.currentPrice);
    if (!spot) return { symbol, ok: false, reason: "no_spot_price" };

    const expectedMoveAbs = toNumber(expectedMove?.expectedMove);
    const hasEarnings = EARNINGS_SYMBOLS.has(symbol);
    const adjustedMove = hasEarnings ? expectedMoveAbs * 2 : expectedMoveAbs;
    const lowerBound = spot - adjustedMove;
    if (!lowerBound || lowerBound <= 0) return { symbol, ok: false, reason: "invalid_lower_bound" };

    const dteDays = getDteDays(expiration);
    const targetWeeks = getTargetWeeks(dteDays);
    const puts = Array.isArray(optionChain?.puts) ? optionChain.puts : [];
    const parsedPuts = puts
      .map((put) => ({
        strike: toNumber(put?.strike),
        bid: toNumber(put?.bid),
        ask: toNumber(put?.ask),
        mid: toNumber(put?.mid),
      }))
      .filter((put) => put.strike > 0);
    const strikeSelection = selectPutStrikes({
      puts,
      spot,
      lowerBoundForSelection: lowerBound,
      dteDays,
    });
    const strikeWindow = [...parsedPuts]
      .sort((a, b) => Math.abs(a.strike - lowerBound) - Math.abs(b.strike - lowerBound))
      .slice(0, 5)
      .map((put) => ({
        strike: round(put.strike, 3),
        bid: round(put.bid, 3),
        ask: round(put.ask, 3),
        mid: round(put.mid, 3),
        strikeVsLowerBound: round(put.strike - lowerBound, 3),
      }));
    const strikeDebug =
      STRIKE_DEBUG_SYMBOLS.has(symbol) || strikeSelection.eligible.length === 0
        ? {
            expirationUsed: expiration,
            currentPrice: round(spot, 3),
            expectedMove: round(expectedMoveAbs, 3),
            adjustedMove: round(adjustedMove, 3),
            lowerBound: round(lowerBound, 3),
            putsTotalCount: parsedPuts.length,
            putsWithBidCount: parsedPuts.filter((put) => put.bid > 0).length,
            putsBelowLowerBoundCount: parsedPuts.filter((put) => put.strike < lowerBound).length,
            putsBelowLowerBoundWithBidCount: parsedPuts.filter(
              (put) => put.strike < lowerBound && put.bid > 0
            ).length,
            nearestPutsAroundLowerBound: strikeWindow,
          }
        : null;

    function buildStrike(row) {
      if (!row) return null;
      const marketPremium = toNumber(row.mid);
      const bidPremium = toNumber(row.conservativePremium);
      const weeklyYield = weeklyYieldDecimal(bidPremium, row.strike, dteDays);
      const weeklyNormalizedYield = dteDays > 0 ? weeklyYield * (7 / dteDays) : 0;
      return {
        strike: row.strike,
        premium: round(marketPremium, 3),
        conservativePremium: round(bidPremium, 3),
        weeklyYield: round(weeklyYield, 4),
        weeklyNormalizedYield: round(weeklyNormalizedYield, 4),
        annualizedYield: round(weeklyYield * 52, 4),
        distancePct: round(Math.abs(row.distancePct) / 100, 4),
        volume: row.volume,
        openInterest: row.openInterest,
        bid: round(row.bid, 3),
        ask: round(row.ask, 3),
        tradability: row.tradability ?? null,
        liquidity: row.liquidity ?? null,
      };
    }

    const safeStrike = buildStrike(strikeSelection.safeStrike);
    const aggressiveStrike = buildStrike(strikeSelection.aggressiveStrike);
    const targetPremium = strikeSelection.targetPremium;
    const support = toNumber(supportResistance?.support) || null;
    const resistance = toNumber(supportResistance?.resistance) || null;
    const strikeVsSupportPct =
      safeStrike && support && support > 0 ? ((safeStrike.strike - support) / support) * 100 : null;
    const strikeVsResistancePct =
      safeStrike && resistance && resistance > 0
        ? ((resistance - safeStrike.strike) / resistance) * 100
        : null;

    let supportStatus = "unknown";
    if (strikeVsSupportPct != null) {
      if (strikeVsSupportPct >= 2) supportStatus = "room_above_support";
      else if (strikeVsSupportPct >= 0) supportStatus = "near_support";
      else supportStatus = "below_support";
    }

    const passesPremiumTarget =
      !!safeStrike && premiumMeetsTarget(safeStrike.conservativePremium, targetPremium);
    const passesYieldTarget = !!safeStrike && (safeStrike.annualizedYield ?? 0) >= 0.26;
    const passesLiquidity = !!safeStrike && !!safeStrike.liquidity?.isLiquid;
    const passesFilter = !!safeStrike && passesPremiumTarget && passesYieldTarget && passesLiquidity;

    let reasonKept = "passes_filters";
    if (!strikeSelection.eligible.length) reasonKept = "no_put_with_bid_below_lower_bound";
    else if (!strikeSelection.liquidEligible.length) reasonKept = "no_liquid_strike_below_lower_bound";
    else if (!strikeSelection.safeCandidates.length) reasonKept = "no_safe_candidate_at_or_above_target_bid";
    else if (!safeStrike) reasonKept = "no_safe_strike";
    else if (!passesLiquidity) reasonKept = "safe_strike_not_liquid";
    else if (!passesPremiumTarget) reasonKept = "premium_below_target";
    else if (!passesYieldTarget) reasonKept = "yield_below_target";

    return {
      symbol,
      ok: true,
      expiration,
      hasEarnings,
      currentPrice: round(spot, 3),
      expectedMove: round(expectedMoveAbs, 3),
      expectedMoveMethod: expectedMove?.method ?? "weighted_60_30_10",
      expectedMoveComponents: expectedMove?.components ?? null,
      adjustedMove: round(adjustedMove, 3),
      lowerBound: round(lowerBound, 3),
      dteDays,
      targetWeeks,
      targetPremium: round(targetPremium, 3),
      targetPremiumRounded: roundMoney(targetPremium),
      safeSelectionMode: strikeSelection.safeSelectionMode,
      safeStrike,
      aggressiveStrike,
      technicals: {
        rsi: technicals?.rsi ?? null,
        trend: technicals?.trend ?? "unknown",
        momentum: technicals?.momentum ?? "unknown",
        sma20: technicals?.sma20 ?? null,
        sma50: technicals?.sma50 ?? null,
      },
      supportResistance: {
        support: supportResistance?.support ?? null,
        resistance: supportResistance?.resistance ?? null,
        strikeVsSupportPct: strikeVsSupportPct != null ? round(strikeVsSupportPct, 2) : null,
        strikeVsResistancePct: strikeVsResistancePct != null ? round(strikeVsResistancePct, 2) : null,
        supportStatus,
      },
      passesFilter,
      debug: {
        eligibleCount: strikeSelection.eligible.length,
        tradableEligibleCount: strikeSelection.tradableEligible.length,
        liquidEligibleCount: strikeSelection.liquidEligible.length,
        safeCandidatesCount: strikeSelection.safeCandidates.length,
        passesPremiumTarget,
        passesYieldTarget,
        passesLiquidity,
        reasonKept,
        safeSelectionMode: strikeSelection.safeSelectionMode,
        strikeDebug,
      },
    };
  }

  async function scanShortlist({ expiration, tickers = [], topN = 20 }) {
    if (!expiration) return { status: 400, payload: { ok: false, error: "expiration is required" } };
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return { status: 400, payload: { ok: false, error: "tickers must be a non-empty array" } };
    }
    if (tickers.length > MAX_SCAN_TICKERS) {
      return {
        status: 400,
        payload: { ok: false, error: `max ${MAX_SCAN_TICKERS} tickers per scan` },
      };
    }

    const cleanedTickers = [
      ...new Set(tickers.map((t) => String(t || "").trim().toUpperCase()).filter(Boolean)),
    ];
    const shortlist = [];
    const rejected = [];
    const errors = [];
    const rejectionReasonCounts = {};
    const stageRejectCounts = {
      no_put_below_lower_bound: 0,
      no_liquid_strike_below_lower_bound: 0,
      premium_below_target: 0,
      yield_below_target: 0,
      no_safe_strike: 0,
      safe_strike_not_liquid: 0,
      failed_final_filter: 0,
    };
    const BATCH_SIZE = 8;

    function countReason(reason) {
      const key = reason || "unknown";
      rejectionReasonCounts[key] = (rejectionReasonCounts[key] || 0) + 1;
      if (key === "no_put_with_bid_below_lower_bound") stageRejectCounts.no_put_below_lower_bound += 1;
      else if (key === "no_liquid_strike_below_lower_bound")
        stageRejectCounts.no_liquid_strike_below_lower_bound += 1;
      else if (key === "premium_below_target") stageRejectCounts.premium_below_target += 1;
      else if (key === "yield_below_target") stageRejectCounts.yield_below_target += 1;
      else if (key === "no_safe_strike") stageRejectCounts.no_safe_strike += 1;
      else if (key === "safe_strike_not_liquid") stageRejectCounts.safe_strike_not_liquid += 1;
      else if (key !== "passes_filters") stageRejectCounts.failed_final_filter += 1;
    }

    for (let i = 0; i < cleanedTickers.length; i += BATCH_SIZE) {
      const batch = cleanedTickers.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(batch.map((symbol) => scanTicker(symbol, expiration)));
      for (let j = 0; j < batchResults.length; j += 1) {
        const result = batchResults[j];
        const symbol = batch[j];
        if (result.status === "fulfilled") {
          const item = result.value;
          if (!item?.ok) {
            const reason = item?.reason || "not_ok";
            countReason(reason);
            rejected.push({
              symbol,
              reason,
              debug: {
                strikeDebug: item?.debug?.strikeDebug ?? null,
              },
            });
            continue;
          }
          if (item.passesFilter) shortlist.push(item);
          else {
            const reason = item?.debug?.reasonKept || "filtered_out";
            countReason(reason);
            rejected.push({
              symbol,
              reason,
              targetPremium: item?.targetPremium ?? null,
              targetPremiumRounded: item?.targetPremiumRounded ?? null,
              safeStrike: item?.safeStrike ?? null,
              aggressiveStrike: item?.aggressiveStrike ?? null,
              safeSelectionMode: item?.safeSelectionMode ?? null,
              debug: {
                strikeDebug: item?.debug?.strikeDebug ?? null,
              },
            });
          }
        } else {
          const reason = result.reason?.message || "scan_failed";
          countReason(reason);
          errors.push({ symbol, error: reason });
        }
      }
    }

    shortlist.sort(
      (a, b) => toNumber(b?.safeStrike?.annualizedYield) - toNumber(a?.safeStrike?.annualizedYield)
    );

    return {
      status: 200,
      payload: {
        ok: true,
        expiration,
        scanned: cleanedTickers.length,
        kept: shortlist.length,
        returned: Math.min(topN, shortlist.length),
        shortlist: shortlist.slice(0, topN),
        rejected,
        errors,
        rejectionReasonCounts,
        stageRejectCounts,
      },
    };
  }

  return { scanTicker, scanShortlist };
}
