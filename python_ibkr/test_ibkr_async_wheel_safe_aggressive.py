"""
Smoke test read-only IBKR: combine expected_move (Barchart-like 60/30/10) et
choix safe/agressif des puts pour la stratégie Wheel.
Aucun ordre, aucun placeOrder, aucun cancelOrder, aucun positions, aucun
accountSummary, aucun executions, aucun reqOpenOrders.
Connect strict avec StartupFetchNONE.
"""
from __future__ import annotations

import json
import math
import os
import traceback
from datetime import datetime, timezone

from ib_async import IB, Option, Stock
from ib_async.ib import StartupFetchNONE

W_ATM = 0.60
W_S1 = 0.30
W_S2 = 0.10
MAX_STRIKE_ATTEMPTS = 10
MIN_PREMIUM_YIELD = 0.005


def _parse_bool(v: str | None, default: bool) -> bool:
    if v is None or str(v).strip() == "":
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _int_env(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return int(str(raw).strip(), 10)
    except ValueError:
        return default


def _str_env(name: str, default: str) -> str:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    return str(raw).strip()


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _safe_attr(obj, name: str):
    try:
        return getattr(obj, name, None)
    except Exception:
        return None


def _finite_number(value):
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(n):
        return None
    if n < 0:
        return None
    return n


def _extract_market_price(ticker):
    market_price_attr = _safe_attr(ticker, "marketPrice")
    if callable(market_price_attr):
        try:
            return _finite_number(market_price_attr())
        except Exception:
            return None
    return _finite_number(market_price_attr)


def _normalize_expiration(x) -> str:
    s = str(x).strip()
    if len(s) == 8 and s.isdigit():
        return s
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return datetime.strptime(s, fmt).strftime("%Y%m%d")
        except ValueError:
            continue
    return s


def _normalize_expirations(raw) -> list[str]:
    if raw is None:
        return []
    items = [raw] if isinstance(raw, (str, bytes)) else list(raw)
    out = []
    for item in items:
        e = _normalize_expiration(item)
        if e and e not in out:
            out.append(e)
    return sorted(out)


def _normalize_strikes(raw) -> list[float]:
    if raw is None:
        return []
    items = [raw] if isinstance(raw, (str, int, float)) else list(raw)
    out = []
    for item in items:
        n = _finite_number(item)
        if n is not None:
            out.append(n)
    return sorted(set(out))


def _pick_underlying_price(bid, ask, last, close, market_price):
    mid = (bid + ask) / 2 if bid is not None and ask is not None else None
    return market_price or last or mid or close


def _pick_chain(chains, symbol: str):
    if not chains:
        return None
    upper_symbol = symbol.upper()

    def _norm(v):
        return str(v or "").strip().upper()

    preferred = []
    fallback = []
    fallback_any = []
    for c in chains:
        ex = _norm(_safe_attr(c, "exchange"))
        tc = _norm(_safe_attr(c, "tradingClass"))
        mult = str(_safe_attr(c, "multiplier") or "").strip()
        is_sym = tc == upper_symbol
        is_100 = mult == "100"
        if ex == "SMART" and is_sym and is_100:
            preferred.append(c)
        elif is_sym and is_100:
            fallback.append(c)
        elif is_sym:
            fallback_any.append(c)
    if preferred:
        return preferred[0]
    if fallback:
        return fallback[0]
    if fallback_any:
        return fallback_any[0]
    return chains[0]


def _pick_expiration(expirations: list[str], requested: str | None):
    if not expirations:
        return None, False
    if requested:
        req = _normalize_expiration(requested)
        if req in expirations:
            return req, True
    today = datetime.now(timezone.utc).date()
    parsed = []
    for e in expirations:
        try:
            parsed.append((datetime.strptime(e, "%Y%m%d").date(), e))
        except ValueError:
            continue
    future = [p for p in parsed if p[0] >= today]
    if future:
        future.sort(key=lambda x: x[0])
        return future[0][1], False
    return expirations[0], False


def _conservative_premium(bid, ask, last, close) -> tuple[float | None, str | None]:
    """Pour les legs du expected move : mid si bid+ask valides, sinon last, bid, close."""
    if bid is not None and ask is not None and ask >= bid and bid > 0:
        return (bid + ask) / 2, "mid"
    if last is not None and last > 0:
        return last, "last"
    if bid is not None and bid > 0:
        return bid, "bid"
    if close is not None and close > 0:
        return close, "close"
    return None, None


def _leg_quotes(ticker) -> dict:
    bid = _finite_number(_safe_attr(ticker, "bid"))
    ask = _finite_number(_safe_attr(ticker, "ask"))
    last = _finite_number(_safe_attr(ticker, "last"))
    close = _finite_number(_safe_attr(ticker, "close"))
    if bid is not None and ask is not None:
        mid = (bid + ask) / 2
    else:
        mid = None
    spread = (ask - bid) if bid is not None and ask is not None else None
    spread_pct = (spread / mid) if (spread is not None and mid and mid > 0) else None
    prime_used, reason = _conservative_premium(bid, ask, last, close)
    return {
        "bid": bid,
        "ask": ask,
        "last": last,
        "close": close,
        "mid": mid,
        "spread": spread,
        "spreadPct": spread_pct,
        "primeUsed": prime_used,
        "primeReason": reason,
    }


def _put_quotes(ticker) -> dict:
    """Pour les puts wheel: primeUsed = bid (conservateur). Pas d'autre fallback."""
    bid = _finite_number(_safe_attr(ticker, "bid"))
    ask = _finite_number(_safe_attr(ticker, "ask"))
    last = _finite_number(_safe_attr(ticker, "last"))
    close = _finite_number(_safe_attr(ticker, "close"))
    if bid is not None and ask is not None:
        mid = (bid + ask) / 2
    else:
        mid = None
    spread = (ask - bid) if bid is not None and ask is not None else None
    spread_pct = (spread / mid) if (spread is not None and mid and mid > 0) else None
    return {
        "bid": bid,
        "ask": ask,
        "last": last,
        "close": close,
        "mid": mid,
        "spread": spread,
        "spreadPct": spread_pct,
        "primeUsed": bid,
    }


def _nearest_atm_index(strikes: list[float], price: float) -> int:
    if not strikes:
        return 0
    return min(range(len(strikes)), key=lambda i: abs(strikes[i] - price))


def main() -> int:
    host = _str_env("IBKR_HOST", "127.0.0.1")
    port = _int_env("IBKR_PORT", 4002)
    client_id = _int_env("IBKR_CLIENT_ID", 213)
    read_only = _parse_bool(os.environ.get("IBKR_READ_ONLY"), True)
    market_data_type = _int_env("IBKR_MARKET_DATA_TYPE", 2)
    symbol = _str_env("IBKR_SYMBOL", "NVDA").upper()
    exchange = _str_env("IBKR_EXCHANGE", "SMART").upper()
    currency = _str_env("IBKR_CURRENCY", "USD").upper()
    option_params_exchange = os.environ.get("IBKR_OPTION_PARAMS_EXCHANGE", "")
    if option_params_exchange is None:
        option_params_exchange = ""
    option_params_exchange = str(option_params_exchange).strip().upper()
    right = _str_env("IBKR_OPTION_RIGHT", "P").upper()
    max_strikes_env = max(1, _int_env("IBKR_MAX_STRIKES", 20))
    max_strikes = max(20, max_strikes_env)
    requested_expiration = os.environ.get("IBKR_OPTION_EXPIRATION")
    requested_expiration = (
        str(requested_expiration).strip() if requested_expiration is not None else ""
    )
    debug = _parse_bool(os.environ.get("DEBUG_IBKR"), False)

    base = {
        "ok": False,
        "mode": "ibkr_readonly_shadow",
        "provider": "IBKR",
        "bridge": "ib_async",
        "readOnly": True,
        "canTrade": False,
        "startupFetchDisabled": True,
        "connected": False,
        "symbol": symbol,
        "method": "wheel_safe_aggressive_ibkr_shadow",
    }

    if not read_only:
        _emit({**base, "error": "IBKR_READ_ONLY doit être true pour ce test (sécurité)."})
        return 1

    ib = IB()
    requested_contracts: list = []
    rejected: list[dict] = []
    em_options_out: list[dict] = []
    warnings: list[str] = []

    try:
        try:
            ib.connect(
                host=host,
                port=port,
                clientId=client_id,
                timeout=6,
                readonly=True,
                fetchFields=StartupFetchNONE,
            )
        except Exception as e:
            _emit(
                {
                    **base,
                    "error": f"connect_failed_startup_fetch_none_required: {type(e).__name__}: {e}",
                }
            )
            return 1

        if not ib.isConnected():
            _emit({**base, "error": "Connexion refusée ou synchronisation incomplète"})
            return 1

        if hasattr(ib, "reqMarketDataType"):
            ib.reqMarketDataType(market_data_type)

        underlying = Stock(symbol, exchange, currency)
        qu = ib.qualifyContracts(underlying)
        if not (isinstance(qu, list) and qu and qu[0]):
            _emit({**base, "connected": True, "error": "underlying_contract_not_qualified"})
            return 1
        underlying = qu[0]
        con_id = _safe_attr(underlying, "conId")
        if not (isinstance(con_id, int) and con_id > 0):
            _emit({**base, "connected": True, "error": "underlying_conid_missing"})
            return 1

        u_tk = ib.reqMktData(underlying, "", False, False)
        requested_contracts.append(underlying)
        ib.sleep(2.0)

        u_b = _finite_number(_safe_attr(u_tk, "bid"))
        u_a = _finite_number(_safe_attr(u_tk, "ask"))
        u_l = _finite_number(_safe_attr(u_tk, "last"))
        u_c = _finite_number(_safe_attr(u_tk, "close"))
        u_mp = _extract_market_price(u_tk)
        underlying_price = _pick_underlying_price(u_b, u_a, u_l, u_c, u_mp)
        if underlying_price is None:
            _emit({**base, "connected": True, "error": "underlying_price_unavailable"})
            return 1

        chains = ib.reqSecDefOptParams(symbol, option_params_exchange, "STK", int(con_id))
        chains = list(chains or [])
        if not chains:
            _emit({**base, "connected": True, "error": "option_params_not_found"})
            return 1
        ch = _pick_chain(chains, symbol)
        if ch is None:
            _emit({**base, "connected": True, "error": "option_chain_selection_failed"})
            return 1

        trading_class = str(_safe_attr(ch, "tradingClass") or symbol).strip().upper()
        expirations = _normalize_expirations(_safe_attr(ch, "expirations"))
        strikes = _normalize_strikes(_safe_attr(ch, "strikes"))
        expiration, _ = _pick_expiration(expirations, requested_expiration)
        if not expiration or not strikes:
            _emit({**base, "connected": True, "error": "no_expiration_or_strikes"})
            return 1

        def _one_option(st: float, rght: str):
            opt = Option(
                symbol=symbol,
                lastTradeDateOrContractMonth=expiration,
                strike=float(st),
                right=rght,
                exchange="SMART",
                currency=currency,
                multiplier="100",
                tradingClass=trading_class,
            )
            qo = ib.qualifyContracts(opt)
            return qo[0] if (isinstance(qo, list) and qo and qo[0]) else None

        original_nearest_raw_index = _nearest_atm_index(strikes, float(underlying_price))
        original_nearest_raw_strike = strikes[original_nearest_raw_index]
        validation_limit = min(40, len(strikes))
        half_window = validation_limit // 2
        start = max(0, original_nearest_raw_index - half_window)
        end = min(len(strikes), start + validation_limit)
        start = max(0, end - validation_limit)
        validation_strikes = strikes[start:end]

        valid_call_contracts: dict[float, object] = {}
        valid_put_contracts: dict[float, object] = {}
        for st in validation_strikes:
            call_contract = _one_option(st, "C")
            if call_contract is not None:
                valid_call_contracts[st] = call_contract
            else:
                rejected.append(
                    {
                        "role": "strike_validation_call",
                        "right": "C",
                        "strike": st,
                        "reason": "option_contract_not_qualified",
                    }
                )
            put_contract = _one_option(st, "P")
            if put_contract is not None:
                valid_put_contracts[st] = put_contract
            else:
                rejected.append(
                    {
                        "role": "strike_validation_put",
                        "right": "P",
                        "strike": st,
                        "reason": "option_contract_not_qualified",
                    }
                )

        valid_call_strikes = sorted(valid_call_contracts)
        valid_put_strikes = sorted(valid_put_contracts)
        valid_straddle_strikes = sorted(
            set(valid_call_strikes).intersection(valid_put_strikes)
        )
        strike_validation = {
            "rawStrikesChecked": len(validation_strikes),
            "validCallStrikesCount": len(valid_call_strikes),
            "validPutStrikesCount": len(valid_put_strikes),
            "validStraddleStrikesCount": len(valid_straddle_strikes),
            "validStraddleStrikesSample": valid_straddle_strikes[:10],
        }

        if not valid_straddle_strikes:
            _emit(
                {
                    **base,
                    "connected": True,
                    "expiration": expiration,
                    "underlyingPrice": underlying_price,
                    "error": "atm_straddle_unavailable",
                    "strikeValidation": strike_validation,
                    "rejected": rejected,
                }
            )
            return 1

        # =========================================================
        # ÉTAPE 4 — Expected move (60/30/10), sur strikes validés
        # =========================================================
        atm_strike = min(valid_straddle_strikes, key=lambda st: abs(st - float(underlying_price)))

        s_atm_c = s_atm_p = atm_strike
        c_atm_c = valid_call_contracts.get(atm_strike)
        c_atm_p = valid_put_contracts.get(atm_strike)
        _a1 = _a2 = [atm_strike]
        n1 = n2 = 1

        calls_above = [st for st in valid_call_strikes if st > atm_strike]
        puts_below = sorted([st for st in valid_put_strikes if st < atm_strike], reverse=True)

        s_call_p1 = calls_above[0] if len(calls_above) >= 1 else None
        s_call_p2 = calls_above[1] if len(calls_above) >= 2 else None
        s_put_m1 = puts_below[0] if len(puts_below) >= 1 else None
        s_put_m2 = puts_below[1] if len(puts_below) >= 2 else None

        c_s1c = valid_call_contracts.get(s_call_p1) if s_call_p1 is not None else None
        c_s2c = valid_call_contracts.get(s_call_p2) if s_call_p2 is not None else None
        c_s1p = valid_put_contracts.get(s_put_m1) if s_put_m1 is not None else None
        c_s2p = valid_put_contracts.get(s_put_m2) if s_put_m2 is not None else None

        a_s1c = [s_call_p1] if s_call_p1 is not None else []
        a_s2c = [s_call_p2] if s_call_p2 is not None else []
        a_s1p = [s_put_m1] if s_put_m1 is not None else []
        a_s2p = [s_put_m2] if s_put_m2 is not None else []
        n_s1c = 1 if s_call_p1 is not None else 0
        n_s2c = 1 if s_call_p2 is not None else 0
        n_s1p = 1 if s_put_m1 is not None else 0
        n_s2p = 1 if s_put_m2 is not None else 0

        leg_tickers: dict[tuple[str, str, float], object] = {}
        leg_meta: dict[tuple[str, str, float], dict] = {}

        def _register_leg(role: str, rght: str, k: float | None, c, att: list, n: int) -> None:
            if c is None or k is None:
                return
            tk = ib.reqMktData(c, "", False, False)
            requested_contracts.append(c)
            key = (role, rght, float(k))
            leg_tickers[key] = tk
            leg_meta[key] = {
                "attemptedStrikes": list(att),
                "selectedAfterAttempts": n,
            }

        if c_atm_c is not None and s_atm_c is not None and n1:
            _register_leg("atm_call", "C", s_atm_c, c_atm_c, _a1, n1)
        if c_atm_p is not None and s_atm_p is not None and n2:
            _register_leg("atm_put", "P", s_atm_p, c_atm_p, _a2, n2)
        if c_s1c is not None and s_call_p1 is not None and n_s1c:
            _register_leg("strangle1_call", "C", s_call_p1, c_s1c, a_s1c, n_s1c)
        if c_s1p is not None and s_put_m1 is not None and n_s1p:
            _register_leg("strangle1_put", "P", s_put_m1, c_s1p, a_s1p, n_s1p)
        if c_s2c is not None and s_call_p2 is not None and n_s2c:
            _register_leg("strangle2_call", "C", s_call_p2, c_s2c, a_s2c, n_s2c)
        if c_s2p is not None and s_put_m2 is not None and n_s2p:
            _register_leg("strangle2_put", "P", s_put_m2, c_s2p, a_s2p, n_s2p)

        # =========================================================
        # ÉTAPE 5 — Sélection des puts wheel (qualification)
        # =========================================================
        puts_below_or_at = [s for s in valid_put_strikes if s <= float(underlying_price)]
        puts_below_or_at.sort(reverse=True)
        chosen_put_strikes = puts_below_or_at[:max_strikes]

        put_tickers: list[tuple[float, object]] = []
        for strike in chosen_put_strikes:
            qc = valid_put_contracts.get(strike)
            if qc is None:
                rejected.append(
                    {
                        "role": "wheel_put",
                        "right": right,
                        "strike": strike,
                        "reason": "option_contract_not_qualified",
                    }
                )
                continue
            tk = ib.reqMktData(qc, "", False, False)
            requested_contracts.append(qc)
            put_tickers.append((strike, tk))

        ib.sleep(5.0)

        # ---------- expected move : extraction quotes ----------
        def _leg_row(role: str, rght: str, k: float):
            t = leg_tickers.get((role, rght, float(k)))
            if t is None:
                return None
            q = _leg_quotes(t)
            m = leg_meta.get((role, rght, float(k)), {})
            em_options_out.append(
                {
                    "role": role,
                    "right": rght,
                    "strike": k,
                    "attemptedStrikes": m.get("attemptedStrikes", []),
                    "selectedAfterAttempts": m.get("selectedAfterAttempts", 0),
                    **q,
                }
            )
            return q["primeUsed"]

        def _pleg(role: str, rght: str, k: float | None) -> float | None:
            if k is None:
                return None
            return _leg_row(role, rght, k)

        p_atm_c = _pleg("atm_call", "C", s_atm_c) if c_atm_c else None
        p_atm_pu = _pleg("atm_put", "P", s_atm_p) if c_atm_p else None
        p_s1_c = _pleg("strangle1_call", "C", s_call_p1)
        p_s1_p = _pleg("strangle1_put", "P", s_put_m1)
        p_s2_c = _pleg("strangle2_call", "C", s_call_p2)
        p_s2_p = _pleg("strangle2_put", "P", s_put_m2)

        if p_atm_c is None or p_atm_pu is None:
            _emit(
                {
                    **base,
                    "connected": True,
                    "expiration": expiration,
                    "underlyingPrice": underlying_price,
                    "error": "atm_straddle_unavailable",
                    "strikeValidation": strike_validation,
                    "rejected": rejected,
                }
            )
            return 1

        atm_straddle_val = p_atm_c + p_atm_pu
        s1_val = (p_s1_c + p_s1_p) if p_s1_c is not None and p_s1_p is not None else None
        s2_val = (p_s2_c + p_s2_p) if p_s2_c is not None and p_s2_p is not None else None

        parts: list[tuple[float, float]] = [(W_ATM, atm_straddle_val)]
        if s1_val is not None:
            parts.append((W_S1, s1_val))
        if s2_val is not None:
            parts.append((W_S2, s2_val))
        w_sum = sum(p[0] for p in parts)
        if w_sum <= 0:
            _emit({**base, "connected": True, "error": "expected_move_unavailable"})
            return 1
        expected_move = sum(p[0] * p[1] for p in parts) / w_sum
        lower_bound = float(underlying_price) - expected_move
        upper_bound = float(underlying_price) + expected_move
        target_premium = float(underlying_price) * MIN_PREMIUM_YIELD

        em_components = {
            "atmStraddle": {
                "available": True,
                "weight": W_ATM,
                "strike": atm_strike,
                "originalNearestRawStrike": original_nearest_raw_strike,
                "selectedValidAtmStrike": atm_strike,
                "selectedFromValidatedStrikes": True,
                "callPrime": p_atm_c,
                "putPrime": p_atm_pu,
                "value": atm_straddle_val,
            },
            "strangle1": {
                "available": s1_val is not None,
                "weight": W_S1,
                "callStrike": s_call_p1,
                "putStrike": s_put_m1,
                "callPrime": p_s1_c,
                "putPrime": p_s1_p,
                "value": s1_val,
            },
            "strangle2": {
                "available": s2_val is not None,
                "weight": W_S2,
                "callStrike": s_call_p2,
                "putStrike": s_put_m2,
                "callPrime": p_s2_c,
                "putPrime": p_s2_p,
                "value": s2_val,
            },
        }

        # =========================================================
        # ÉTAPE 6/7 — Construire les puts puis choisir agressif/safe
        # =========================================================
        put_data: list[dict] = []
        for strike, tk in put_tickers:
            q = _put_quotes(tk)
            bid = q["bid"]
            mid = q["mid"]
            prime_used = q["primeUsed"]
            premium_yield = (
                (prime_used / strike)
                if (prime_used is not None and strike and strike > 0)
                else None
            )
            premium_vs_target = (
                prime_used - target_premium if prime_used is not None else None
            )
            premium_yield_on_underlying = (
                prime_used / float(underlying_price)
                if prime_used is not None and float(underlying_price) > 0
                else None
            )
            passes_min = bool(prime_used is not None and prime_used >= target_premium)
            is_below = bool(strike < lower_bound)
            distance_below = (lower_bound - strike) if is_below else None

            if not is_below:
                status = "rejected"
                reason = "above_or_equal_lower_bound"
            elif bid is None:
                status = "rejected"
                reason = "invalid_bid"
            elif q["ask"] is None:
                status = "rejected"
                reason = "invalid_ask"
            elif mid is None or mid <= 0:
                status = "rejected"
                reason = "invalid_mid"
            elif not passes_min:
                status = "rejected"
                reason = "premium_below_min"
            else:
                status = "kept"
                reason = "passes_min_premium"

            put_data.append(
                {
                    "strike": strike,
                    "bid": bid,
                    "ask": q["ask"],
                    "last": q["last"],
                    "close": q["close"],
                    "mid": mid,
                    "spread": q["spread"],
                    "spreadPct": q["spreadPct"],
                    "primeUsed": prime_used,
                    "premiumYield": premium_yield,
                    "targetPremium": target_premium,
                    "premiumVsTarget": premium_vs_target,
                    "premiumYieldOnUnderlying": premium_yield_on_underlying,
                    "passesMinPremium": passes_min,
                    "isBelowLowerBound": is_below,
                    "distanceBelowLowerBound": distance_below,
                    "status": status,
                    "reason": reason,
                }
            )

        # Agressif : strike qualifié le plus haut sous lowerBound
        below = [p for p in put_data if p["isBelowLowerBound"]]
        aggressive_pc = (
            max(below, key=lambda p: p["strike"]) if below else None
        )

        # Pool safe : strictement sous l'agressif, quotes valides, bid >= targetPremium.
        safe_pool: list[dict] = []
        if aggressive_pc is not None:
            safe_pool = [
                p
                for p in below
                if p["strike"] < aggressive_pc["strike"]
                and p["bid"] is not None
                and p["ask"] is not None
                and p["mid"] is not None
                and p["mid"] > 0
                and p["passesMinPremium"]
            ]

        safe_pc: dict | None = None
        safe_selection_reason: str | None = None
        if safe_pool:
            safe_pc = min(safe_pool, key=lambda p: p["strike"])
            safe_selection_reason = "below_aggressive_meets_min_premium"
        elif aggressive_pc is not None and aggressive_pc.get("passesMinPremium"):
            safe_pc = aggressive_pc
            safe_selection_reason = (
                "aggressive_promoted_to_safe_no_lower_acceptable_strike"
            )
        else:
            if aggressive_pc is not None:
                safe_selection_reason = "no_safe_candidate_meets_min_premium"
            else:
                safe_selection_reason = "no_put_below_lower_bound"

        # Marquer les statuts dans put_data
        if aggressive_pc is not None and safe_pc is not None and (
            aggressive_pc is safe_pc
        ):
            aggressive_pc["status"] = "aggressive_and_safe_selected"
            aggressive_pc["reason"] = "aggressive_promoted_to_safe_no_lower_acceptable_strike"
        else:
            if aggressive_pc is not None:
                if aggressive_pc.get("passesMinPremium"):
                    aggressive_pc["status"] = "aggressive_selected"
                    aggressive_pc["reason"] = "directly_below_lower_bound"
                else:
                    aggressive_pc["status"] = "agressif_rejected_for_min_premium"
                    aggressive_pc["reason"] = "premium_below_min"
            if safe_pc is not None and safe_pc is not aggressive_pc:
                safe_pc["status"] = "safe_selected"
                safe_pc["reason"] = "below_aggressive_meets_min_premium"

        if aggressive_pc is None:
            warnings.append("no_put_below_lower_bound")

        def _selection_obj(pc: dict | None, sel_reason: str) -> dict | None:
            if pc is None:
                return None
            return {
                "strike": pc["strike"],
                "bid": pc["bid"],
                "ask": pc["ask"],
                "last": pc["last"],
                "close": pc["close"],
                "mid": pc["mid"],
                "spread": pc["spread"],
                "spreadPct": pc["spreadPct"],
                "primeUsed": pc["primeUsed"],
                "premiumYield": pc["premiumYield"],
                "targetPremium": pc["targetPremium"],
                "premiumVsTarget": pc["premiumVsTarget"],
                "premiumYieldOnUnderlying": pc["premiumYieldOnUnderlying"],
                "passesMinPremium": pc["passesMinPremium"],
                "isBelowLowerBound": pc["isBelowLowerBound"],
                "distanceBelowLowerBound": pc["distanceBelowLowerBound"],
                "selectionReason": sel_reason,
            }

        aggressive_obj = _selection_obj(
            aggressive_pc, "directly_below_lower_bound"
        )
        safe_obj = _selection_obj(safe_pc, safe_selection_reason or "")

        put_data.sort(
            key=lambda r: (r.get("strike") is None, -(r.get("strike") or 0))
        )
        rejected.sort(
            key=lambda r: (r.get("strike") is None, -(r.get("strike") or 0))
        )

        out = {
            "ok": True,
            "mode": "ibkr_readonly_shadow",
            "provider": "IBKR",
            "bridge": "ib_async",
            "readOnly": True,
            "canTrade": False,
            "startupFetchDisabled": True,
            "symbol": symbol,
            "expiration": expiration,
            "underlyingPrice": underlying_price,
            "method": "wheel_safe_aggressive_ibkr_shadow",
            "expectedMove": round(expected_move, 4),
            "lowerBound": round(lower_bound, 4),
            "upperBound": round(upper_bound, 4),
            "weightSumUsed": round(w_sum, 6),
            "minPremiumYield": MIN_PREMIUM_YIELD,
            "targetPremium": target_premium,
            "strikeValidation": strike_validation,
            "expectedMoveComponents": em_components,
            "expectedMoveOptions": em_options_out,
            "aggressiveStrike": aggressive_obj,
            "safeStrike": safe_obj,
            "safeSelectionReason": safe_selection_reason,
            "putCandidates": put_data,
            "rejected": rejected,
            "warnings": warnings,
            "explanations": {
                "premiumRule": "primeUsed = bid; minimum = underlyingPrice * 0.5% par expiration",
                "aggressiveRule": "strike put directement sous la borne basse",
                "safeRule": (
                    "safe = plus bas strike sous l'agressif qui respecte targetPremium; "
                    "si aucun plus bas ne respecte et que l'agressif respecte, "
                    "l'agressif devient safe"
                ),
                "spreadRule": (
                    "spread affiché pour information; ne rejette pas à lui seul le "
                    "choix agressif/safe"
                ),
            },
        }
        _emit(out)
        return 0
    except Exception as e:
        err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        if debug:
            err = err + " | " + traceback.format_exc().replace("\n", " ")
        _emit(
            {
                **base,
                "connected": bool(getattr(ib, "isConnected", lambda: False)()),
                "error": err,
            }
        )
        return 1
    finally:
        try:
            if ib.isConnected():
                seen = set()
                for c in requested_contracts:
                    cid = _safe_attr(c, "conId")
                    key = (
                        cid,
                        _safe_attr(c, "localSymbol"),
                        _safe_attr(c, "secType"),
                        _safe_attr(c, "strike"),
                    )
                    if key in seen:
                        continue
                    seen.add(key)
                    try:
                        ib.cancelMktData(c)
                    except Exception:
                        pass
        except Exception:
            pass
        try:
            if ib.isConnected():
                ib.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
