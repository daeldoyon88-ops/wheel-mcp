"""
Smoke test read-only: candidats Wheel (puts) depuis IBKR en shadow mode.
Ce script ne place aucun ordre et ne lit aucun flux compte/positions/executions au connect.
"""
from __future__ import annotations

import json
import math
import os
import traceback
from datetime import datetime, timezone

from ib_async import IB, Option, Stock
from ib_async.ib import StartupFetchNONE

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
    fallback_any_symbol = []
    for c in chains:
        ex = _norm(_safe_attr(c, "exchange"))
        tc = _norm(_safe_attr(c, "tradingClass"))
        mult = str(_safe_attr(c, "multiplier") or "").strip()
        is_symbol = tc == upper_symbol
        is_mult_100 = mult == "100"
        if ex == "SMART" and is_symbol and is_mult_100:
            preferred.append(c)
        elif is_symbol and is_mult_100:
            fallback.append(c)
        elif is_symbol:
            fallback_any_symbol.append(c)

    if preferred:
        return preferred[0]
    if fallback:
        return fallback[0]
    if fallback_any_symbol:
        return fallback_any_symbol[0]
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


def main() -> int:
    host = _str_env("IBKR_HOST", "127.0.0.1")
    port = _int_env("IBKR_PORT", 4002)
    client_id = _int_env("IBKR_CLIENT_ID", 206)
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
    max_strikes = max(1, _int_env("IBKR_MAX_STRIKES", 7))
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
    }

    if not read_only:
        _emit({**base, "error": "IBKR_READ_ONLY doit être true pour ce test (sécurité)."})
        return 1

    ib = IB()
    requested_contracts = []

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

        underlying_contract = Stock(symbol, exchange, currency)
        qualified_underlying = ib.qualifyContracts(underlying_contract)
        if not (isinstance(qualified_underlying, list) and qualified_underlying and qualified_underlying[0]):
            _emit({**base, "connected": True, "error": "underlying_contract_not_qualified"})
            return 1
        underlying_contract = qualified_underlying[0]
        underlying_con_id = _safe_attr(underlying_contract, "conId")
        if not (isinstance(underlying_con_id, int) and underlying_con_id > 0):
            _emit({**base, "connected": True, "error": "underlying_conid_missing"})
            return 1

        underlying_ticker = ib.reqMktData(underlying_contract, "", False, False)
        requested_contracts.append(underlying_contract)
        ib.sleep(2.0)

        u_bid = _finite_number(_safe_attr(underlying_ticker, "bid"))
        u_ask = _finite_number(_safe_attr(underlying_ticker, "ask"))
        u_last = _finite_number(_safe_attr(underlying_ticker, "last"))
        u_close = _finite_number(_safe_attr(underlying_ticker, "close"))
        u_market_price = _extract_market_price(underlying_ticker)
        underlying_price = _pick_underlying_price(u_bid, u_ask, u_last, u_close, u_market_price)
        if underlying_price is None:
            _emit({**base, "connected": True, "error": "underlying_price_unavailable"})
            return 1

        option_params = ib.reqSecDefOptParams(
            symbol,
            option_params_exchange,
            "STK",
            int(underlying_con_id),
        )
        option_params = list(option_params or [])
        if not option_params:
            _emit({**base, "connected": True, "error": "option_params_not_found"})
            return 1

        selected_chain = _pick_chain(option_params, symbol)
        if selected_chain is None:
            _emit({**base, "connected": True, "error": "option_chain_selection_failed"})
            return 1

        trading_class = str(_safe_attr(selected_chain, "tradingClass") or symbol).strip().upper()
        expirations = _normalize_expirations(_safe_attr(selected_chain, "expirations"))
        strikes = _normalize_strikes(_safe_attr(selected_chain, "strikes"))

        expiration, _requested_found = _pick_expiration(expirations, requested_expiration)
        if expiration is None:
            _emit({**base, "connected": True, "error": "no_expiration_available"})
            return 1

        puts_strikes = [s for s in strikes if s <= underlying_price]
        if not puts_strikes:
            puts_strikes = sorted(strikes, key=lambda s: abs(s - underlying_price))
        sorted_by_proximity = sorted(puts_strikes, key=lambda s: abs(s - underlying_price))
        chosen = sorted_by_proximity[:max_strikes]
        chosen_strikes = sorted(chosen, reverse=True)
        if not chosen_strikes:
            _emit({**base, "connected": True, "error": "no_strikes_selected"})
            return 1

        candidates = []
        rejected = []
        option_tickers = []

        for strike in chosen_strikes:
            option_req = Option(
                symbol=symbol,
                lastTradeDateOrContractMonth=expiration,
                strike=strike,
                right=right,
                exchange="SMART",
                currency=currency,
                multiplier="100",
                tradingClass=trading_class,
            )
            qualified_option = ib.qualifyContracts(option_req)
            option_contract = None
            if isinstance(qualified_option, list) and qualified_option and qualified_option[0]:
                option_contract = qualified_option[0]

            if option_contract is None:
                rejected.append({"strike": strike, "reason": "option_contract_not_qualified"})
                continue

            ticker = ib.reqMktData(option_contract, "", False, False)
            requested_contracts.append(option_contract)
            option_tickers.append((strike, ticker))

        ib.sleep(5.0)

        for strike, ticker in option_tickers:
            bid = _finite_number(_safe_attr(ticker, "bid"))
            ask = _finite_number(_safe_attr(ticker, "ask"))
            last = _finite_number(_safe_attr(ticker, "last"))
            close = _finite_number(_safe_attr(ticker, "close"))
            mid = ((bid + ask) / 2) if bid is not None and ask is not None else None
            spread = (ask - bid) if bid is not None and ask is not None else None
            spread_pct = (spread / mid) if (spread is not None and mid not in (None, 0)) else None

            prime_used = bid
            premium_yield = (prime_used / strike) if (prime_used is not None and strike > 0) else None
            passes_min_premium = bool(
                premium_yield is not None and premium_yield >= MIN_PREMIUM_YIELD
            )

            if bid is None:
                status = "rejected"
                reason = "invalid_bid"
            elif ask is None:
                status = "rejected"
                reason = "invalid_ask"
            elif mid is None or mid <= 0:
                status = "rejected"
                reason = "invalid_mid"
            elif not passes_min_premium:
                status = "rejected"
                reason = "premium_below_min"
            else:
                status = "kept"
                reason = "passes_min_premium"

            candidates.append(
                {
                    "strike": strike,
                    "bid": bid,
                    "ask": ask,
                    "last": last,
                    "mid": mid,
                    "spread": spread,
                    "spreadPct": spread_pct,
                    "primeUsed": prime_used,
                    "premiumYield": premium_yield,
                    "passesMinPremium": passes_min_premium,
                    "status": status,
                    "reason": reason,
                    "close": close,
                }
            )

        candidates.sort(key=lambda r: (r.get("strike") is None, -(r.get("strike") or 0)))
        rejected.sort(key=lambda r: (r.get("strike") is None, -(r.get("strike") or 0)))

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
            "minPremiumYield": MIN_PREMIUM_YIELD,
            "candidates": candidates,
            "rejected": rejected,
        }
        _emit(out)
        return 0

    except Exception as e:
        err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        if debug:
            err = err + " | " + traceback.format_exc().replace("\n", " ")
        _emit({**base, "connected": bool(getattr(ib, "isConnected", lambda: False)()), "error": err})
        return 1
    finally:
        try:
            if ib.isConnected():
                seen = set()
                for c in requested_contracts:
                    cid = _safe_attr(c, "conId")
                    key = (cid, _safe_attr(c, "localSymbol"), _safe_attr(c, "secType"), _safe_attr(c, "strike"))
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
