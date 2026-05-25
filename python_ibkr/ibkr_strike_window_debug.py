"""Diagnostic console logging for IBKR strike window (read-only, opt-in)."""
from __future__ import annotations

import math
import os
import sys
from datetime import datetime, timezone


def parse_bool(value: str | None, default: bool) -> bool:
    if value is None or str(value).strip() == "":
        return default
    return str(value).strip().lower() in ("1", "true", "yes", "on")


def strike_window_debug_enabled(raw: str | None = None) -> bool:
    if raw is None:
        raw = os.environ.get("IBKR_STRIKE_WINDOW_DEBUG")
    return parse_bool(raw, False)


def normalize_expiration(value: str) -> str:
    text = str(value).strip()
    if len(text) == 8 and text.isdigit():
        return text
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y%m%d")
        except ValueError:
            continue
    return text


def compute_dte(expiration: str, today=None) -> int | None:
    try:
        exp_date = datetime.strptime(normalize_expiration(expiration), "%Y%m%d").date()
    except (ValueError, TypeError):
        return None
    ref = today if today is not None else datetime.now(timezone.utc).date()
    return (exp_date - ref).days


def format_expiration_display(expiration: str) -> str:
    try:
        dt = datetime.strptime(normalize_expiration(expiration), "%Y%m%d")
        return dt.strftime("%Y-%m-%d")
    except (ValueError, TypeError):
        return str(expiration)


def format_strike(strike: float) -> str:
    if math.isclose(strike, round(strike)):
        return str(int(round(strike)))
    return f"{strike:g}"


def format_strike_list(strikes: list[float]) -> str:
    return "[" + ",".join(format_strike(strike) for strike in strikes) + "]"


def strike_vs_lower_bound(strike, lower_bound) -> tuple[str, float | None]:
    if strike is None or lower_bound is None:
        return "unknown", None
    try:
        strike_value = float(strike)
        lower_bound_value = float(lower_bound)
    except (TypeError, ValueError):
        return "unknown", None
    if lower_bound_value <= 0 or not math.isfinite(strike_value) or not math.isfinite(lower_bound_value):
        return "unknown", None
    relation = "below" if strike_value < lower_bound_value else "equal_or_above"
    distance_pct = round(((strike_value - lower_bound_value) / lower_bound_value) * 100.0, 2)
    return relation, distance_pct


def _format_strike_line(label: str, strike, lower_bound) -> str:
    relation, distance_pct = strike_vs_lower_bound(strike, lower_bound)
    if strike is None:
        return f"{label}=null (unknown)"
    strike_text = format_strike(float(strike))
    if relation == "unknown" or distance_pct is None:
        return f"{label}={strike_text} (unknown)"
    relation_text = "below lowerBound" if relation == "below" else "equal_or_above lowerBound"
    sign = "+" if distance_pct >= 0 else ""
    return f"{label}={strike_text} ({relation_text}, {sign}{distance_pct}%)"


def log_strike_window_debug(
    *,
    ticker: str,
    expiration: str,
    spot: float,
    expected_move: float | None,
    lower_bound: float | None,
    upper_bound: float | None,
    two_phase_enabled: bool,
    two_phase_put_window: int,
    strikes: list[float],
    chosen_put_strikes: list[float],
    aggressive_reference_strike: float | None,
    safe_strike,
    aggressive_strike,
    enabled: bool | None = None,
) -> None:
    if enabled is None:
        enabled = strike_window_debug_enabled()
    if not enabled:
        return

    mode = "TWO_PHASE" if two_phase_enabled else "NORMAL"
    dte = compute_dte(expiration)
    dte_text = str(dte) if dte is not None else "?"
    exp_display = format_expiration_display(expiration)
    spot_value = float(spot)
    expected_move_pct = (
        round((float(expected_move) / spot_value) * 100.0, 2)
        if expected_move is not None and spot_value > 0
        else None
    )

    available_puts = len(strikes)
    below_spot = sum(1 for strike in strikes if strike < spot_value)
    below_lower_bound = (
        sum(1 for strike in strikes if lower_bound is not None and strike < float(lower_bound))
        if lower_bound is not None
        else 0
    )

    lines = [
        f"[IBKR STRIKE WINDOW] {ticker} {exp_display}",
        f"mode={mode} window={two_phase_put_window} dte={dte_text}",
    ]

    if expected_move_pct is not None and lower_bound is not None and upper_bound is not None:
        lines.append(
            "spot="
            f"{spot_value:g} expectedMove={expected_move_pct:g}% "
            f"lowerBound={float(lower_bound):g} upperBound={float(upper_bound):g}"
        )
    elif lower_bound is not None and upper_bound is not None:
        lines.append(
            f"spot={spot_value:g} lowerBound={float(lower_bound):g} upperBound={float(upper_bound):g}"
        )
    else:
        lines.append(f"spot={spot_value:g}")

    lines.append(
        f"availablePuts={available_puts} belowSpot={below_spot} belowLowerBound={below_lower_bound}"
    )

    if two_phase_enabled:
        reference_text = (
            format_strike(float(aggressive_reference_strike))
            if aggressive_reference_strike is not None
            else "null"
        )
        lines.append(f"referenceStrike={reference_text}")
    else:
        lines.append("warning=NORMAL mode uses strikes under spot, not lowerBound")

    lines.append(f"chosenPutStrikes={format_strike_list(chosen_put_strikes)}")
    lines.append(_format_strike_line("safe", safe_strike, lower_bound))
    lines.append(_format_strike_line("aggressive", aggressive_strike, lower_bound))

    warnings: list[str] = []
    if lower_bound is None:
        warnings.append("LOWER_BOUND_MISSING")
    elif below_lower_bound == 0:
        warnings.append("NO_PUTS_BELOW_LOWER_BOUND")

    safe_relation, _ = strike_vs_lower_bound(safe_strike, lower_bound)
    aggressive_relation, _ = strike_vs_lower_bound(aggressive_strike, lower_bound)
    if safe_relation == "equal_or_above":
        warnings.append("SAFE_ABOVE_OR_EQUAL_LOWER_BOUND")
    if aggressive_relation == "equal_or_above":
        warnings.append("AGGRESSIVE_ABOVE_OR_EQUAL_LOWER_BOUND")

    for warning in warnings:
        lines.append(f"warning={warning}")

    for line in lines:
        print(line, file=sys.stderr, flush=True)
