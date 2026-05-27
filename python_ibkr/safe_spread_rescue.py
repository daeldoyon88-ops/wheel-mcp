"""Rescue SAFE local quand le strike choisi est rejeté pour spread."""

from __future__ import annotations

TWO_PHASE_PUT_WINDOW = 10
SAFE_SPREAD_RESCUE_STRIKES_ABOVE = 2
SAFE_SPREAD_RESCUE_STRIKES_BELOW = 4
SAFE_SPREAD_REJECT_PCT = 35.0
SAFE_SPREAD_ACCEPTABLE_PCT = 20.0
SAFE_MIN_YIELD_PCT = 0.5


def normalize_spread_pct_percent(raw: float | None) -> float | None:
    if raw is None:
        return None
    try:
        x = float(raw)
    except (TypeError, ValueError):
        return None
    if x >= 0 and x <= 1.0001:
        return x * 100.0
    return x


def premium_yield_pct(put: dict) -> float | None:
    strike = put.get("strike")
    prime = put.get("primeUsed")
    if strike is None or prime is None:
        return None
    try:
        strike_f = float(strike)
        prime_f = float(prime)
    except (TypeError, ValueError):
        return None
    if strike_f <= 0 or prime_f <= 0:
        return None
    py = put.get("premiumYield")
    if py is not None:
        try:
            py_f = float(py)
            if py_f > 0:
                return py_f * 100.0 if py_f <= 1.0 else py_f
        except (TypeError, ValueError):
            pass
    return (prime_f / strike_f) * 100.0


def is_safe_rejected_for_spread(spread_pct_raw: float | None) -> bool:
    spread = normalize_spread_pct_percent(spread_pct_raw)
    if spread is None:
        return False
    return spread > SAFE_SPREAD_REJECT_PCT


def is_spread_acceptable(spread_pct_raw: float | None) -> bool:
    spread = normalize_spread_pct_percent(spread_pct_raw)
    if spread is None:
        return False
    return spread <= SAFE_SPREAD_ACCEPTABLE_PCT


def build_safe_rescue_strike_window(
    original_strike: float,
    sorted_strikes: list[float],
    strikes_above: int = SAFE_SPREAD_RESCUE_STRIKES_ABOVE,
    strikes_below: int = SAFE_SPREAD_RESCUE_STRIKES_BELOW,
) -> list[float]:
    ladder = sorted({float(s) for s in sorted_strikes if s is not None})
    if not ladder or original_strike is None:
        return []
    strike = float(original_strike)
    try:
        idx = ladder.index(strike)
    except ValueError:
        idx = next((i for i, s in enumerate(ladder) if s >= strike), len(ladder))
        if idx > 0 and abs(ladder[idx - 1] - strike) < abs(ladder[idx] - strike if idx < len(ladder) else strike + 999):
            idx -= 1
    below = ladder[max(0, idx - strikes_below) : idx]
    above = ladder[idx + 1 : idx + 1 + strikes_above]
    return [s for s in (*below, *above) if s != strike]


def _rank_key(put: dict, ctx: dict) -> tuple:
    spread = normalize_spread_pct_percent(put.get("spreadPct"))
    yield_pct = premium_yield_pct(put)
    strike = float(put.get("strike") or 0)
    original = float(ctx.get("original_strike") or 0)
    spot = ctx.get("spot")
    spread_tier = 0 if is_spread_acceptable(spread) else (1 if spread is not None and spread <= 35 else 2)
    spread_val = spread if spread is not None else 999.0
    yield_ok = 0 if (yield_pct is not None and yield_pct >= SAFE_MIN_YIELD_PCT) else 1
    bid_ok = 0 if (put.get("bid") is not None and float(put.get("bid") or 0) > 0) else 1
    dist = 0.0
    if spot is not None and spot > 0:
        dist = -((float(spot) - strike) / float(spot)) * 100.0
    proximity = abs(strike - original) if original else 999.0
    return (spread_tier, spread_val, yield_ok, bid_ok, -dist, proximity, -strike)


def _is_safe_distance_ok(put: dict, ctx: dict) -> bool:
    strike = put.get("strike")
    lb = ctx.get("lower_bound")
    agg = ctx.get("aggressive_strike")
    spot = ctx.get("spot")
    if put.get("isBelowLowerBound") is False:
        return False
    if strike is not None and lb is not None and float(strike) >= float(lb):
        return False
    if strike is not None and agg is not None and float(strike) >= float(agg):
        return False
    if strike is not None and spot is not None and float(spot) > 0:
        dist_pct = ((float(spot) - float(strike)) / float(spot)) * 100.0
        if dist_pct < 2:
            return False
    return True


def evaluate_safe_rescue_candidates(
    *,
    original_safe: dict,
    put_by_strike: dict[float, dict],
    rescue_strikes: list[float],
    lower_bound: float | None,
    aggressive_strike: float | None,
    target_premium: float | None,
    spot: float | None,
) -> dict:
    original_spread = normalize_spread_pct_percent(original_safe.get("spreadPct"))
    ctx = {
        "original_strike": original_safe.get("strike"),
        "spot": spot,
        "lower_bound": lower_bound,
        "aggressive_strike": aggressive_strike,
    }
    checked: list[float] = []
    eligible: list[tuple[tuple, dict]] = []
    for strike in rescue_strikes:
        checked.append(strike)
        put = put_by_strike.get(float(strike))
        if put is None:
            continue
        spread = normalize_spread_pct_percent(put.get("spreadPct"))
        if spread is None or original_spread is None or not (spread < original_spread):
            continue
        if put.get("bid") is None or float(put.get("bid") or 0) <= 0:
            continue
        tgt = float(target_premium or 0)
        prime = float(put.get("primeUsed") or 0)
        if tgt > 0 and prime < tgt:
            continue
        yld = premium_yield_pct(put)
        if yld is None or yld < SAFE_MIN_YIELD_PCT:
            continue
        if not _is_safe_distance_ok(put, ctx):
            continue
        eligible.append((_rank_key(put, ctx), put))
    eligible.sort(key=lambda row: row[0])
    winner = eligible[0][1] if eligible else None
    return {"checked": checked, "winner": winner}


def attempt_safe_spread_rescue(
    *,
    safe_pc: dict | None,
    aggressive_pc: dict | None,
    put_data: list[dict],
    strikes: list[float],
    lower_bound: float | None,
    target_premium: float | None,
    spot: float | None,
) -> tuple[dict | None, dict]:
    empty = {
        "safeSpreadRescueTriggered": False,
        "safeOriginalStrike": None,
        "safeOriginalBidAsk": None,
        "safeOriginalSpread": None,
        "safeRescueCandidatesChecked": [],
        "safeRescueStrike": None,
        "safeRescueBidAsk": None,
        "safeRescueSpread": None,
        "safeRescueReason": None,
    }
    if safe_pc is None:
        return safe_pc, empty

    original_spread = normalize_spread_pct_percent(safe_pc.get("spreadPct"))
    empty.update(
        {
            "safeOriginalStrike": safe_pc.get("strike"),
            "safeOriginalBidAsk": f"{safe_pc.get('bid')}/{safe_pc.get('ask')}",
            "safeOriginalSpread": original_spread,
        }
    )

    if not is_safe_rejected_for_spread(safe_pc.get("spreadPct")):
        empty["safeRescueReason"] = "safe_not_rejected_for_spread"
        return safe_pc, empty

    put_by_strike = {float(p["strike"]): p for p in put_data if p.get("strike") is not None}
    rescue_strikes = build_safe_rescue_strike_window(
        float(safe_pc["strike"]),
        [float(s) for s in strikes if s is not None],
    )
    agg_strike = aggressive_pc.get("strike") if aggressive_pc else None
    evaluation = evaluate_safe_rescue_candidates(
        original_safe=safe_pc,
        put_by_strike=put_by_strike,
        rescue_strikes=rescue_strikes,
        lower_bound=lower_bound,
        aggressive_strike=agg_strike,
        target_premium=target_premium,
        spot=spot,
    )

    diag = {
        **empty,
        "safeSpreadRescueTriggered": True,
        "safeRescueCandidatesChecked": evaluation["checked"],
        "safeRescueReason": "no_acceptable_rescue_candidate",
    }

    winner = evaluation.get("winner")
    if winner is None:
        return safe_pc, diag

    rescued_spread = normalize_spread_pct_percent(winner.get("spreadPct"))
    diag.update(
        {
            "safeRescueStrike": winner.get("strike"),
            "safeRescueBidAsk": f"{winner.get('bid')}/{winner.get('ask')}",
            "safeRescueSpread": rescued_spread,
            "safeRescueReason": (
                "replaced_with_acceptable_spread"
                if is_spread_acceptable(winner.get("spreadPct"))
                else "replaced_with_cleaner_spread"
            ),
        }
    )

    rescued = dict(safe_pc)
    rescued.update(winner)
    rescued["status"] = "safe_selected"
    rescued["reason"] = "safe_spread_rescue_local"
    rescued["selectionReason"] = "safe_spread_rescue_local"
    rescued["safeSpreadRescueApplied"] = True
    rescued["safeSpreadRescueDiagnostics"] = diag
    return rescued, diag
