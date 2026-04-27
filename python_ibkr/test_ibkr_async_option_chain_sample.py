"""
Smoke test read-only: construit un échantillon de puts autour du prix sous-jacent.
Utilise reqMktData uniquement pour lecture de quotes (aucun ordre).
"""
from __future__ import annotations

import json
import math
import os
import traceback
from datetime import datetime, timezone


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


def _resolve_fetch_fields_none():
    try:
        from ib_async.ib import StartupFetchNONE  # type: ignore[attr-defined]

        return StartupFetchNONE
    except (ImportError, AttributeError):
        return None


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _safe_attr(obj, name: str):
    try:
        return getattr(obj, name, None)
    except Exception:
        return None


def _finite_number(value):
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


def _timestamp_iso(ticker):
    t = _safe_attr(ticker, "time")
    if isinstance(t, datetime):
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return t.astimezone(timezone.utc).isoformat()
    return datetime.now(timezone.utc).isoformat()


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
    if isinstance(raw, (str, bytes)):
        items = [raw]
    else:
        items = list(raw)
    out = []
    for item in items:
        e = _normalize_expiration(item)
        if e and e not in out:
            out.append(e)
    return sorted(out)


def _normalize_strikes(raw) -> list[float]:
    if raw is None:
        return []
    if isinstance(raw, (str, int, float)):
        items = [raw]
    else:
        items = list(raw)
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
    client_id = _int_env("IBKR_CLIENT_ID", 205)
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
        "provider": "IBKR",
        "bridge": "ib_async",
        "mode": "readonly",
        "readOnly": True,
        "canTrade": False,
        "connected": False,
        "symbol": symbol,
        "marketDataType": market_data_type,
        "host": host,
        "port": port,
        "clientId": client_id,
    }

    if not read_only:
        _emit({**base, "error": "IBKR_READ_ONLY doit être true pour ce test (sécurité)."})
        return 1

    try:
        from ib_async import IB, Option, Stock
    except ImportError as e:
        _emit({**base, "error": f"Import ib_async impossible: {e!s}"})
        return 1

    fetch_fields = _resolve_fetch_fields_none()
    ib = IB()
    requested_contracts = []
    warnings = []

    try:
        connect_kw = {
            "host": host,
            "port": port,
            "clientId": client_id,
            "timeout": 6,
            "readonly": True,
        }
        if fetch_fields is not None:
            connect_kw["fetchFields"] = fetch_fields

        try:
            ib.connect(**connect_kw)
        except TypeError:
            connect_kw.pop("readonly", None)
            ib.connect(**connect_kw)

        if not ib.isConnected():
            _emit({**base, "error": "Connexion refusée ou synchronisation incomplète (isConnected() == false)."})
            return 1

        if hasattr(ib, "reqMarketDataType"):
            ib.reqMarketDataType(market_data_type)

        underlying_contract = Stock(symbol, exchange, currency)
        qualified_underlying = ib.qualifyContracts(underlying_contract)
        if not (isinstance(qualified_underlying, list) and qualified_underlying and qualified_underlying[0]):
            _emit({**base, "connected": bool(ib.isConnected()), "error": "underlying_contract_not_qualified"})
            return 1
        underlying_contract = qualified_underlying[0]
        underlying_con_id = _safe_attr(underlying_contract, "conId")
        if not (isinstance(underlying_con_id, int) and underlying_con_id > 0):
            _emit({**base, "connected": bool(ib.isConnected()), "error": "underlying_conid_missing"})
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
        if option_params is None:
            option_params = []
        option_params = list(option_params)
        if not option_params:
            _emit(
                {
                    **base,
                    "connected": True,
                    "underlying": {
                        "price": underlying_price,
                        "bid": u_bid,
                        "ask": u_ask,
                        "last": u_last,
                        "close": u_close,
                        "conId": int(underlying_con_id),
                    },
                    "warnings": ["option_params_empty"],
                    "error": "option_params_not_found",
                }
            )
            return 1

        selected_chain = _pick_chain(option_params, symbol)
        if selected_chain is None:
            _emit({**base, "connected": True, "error": "option_chain_selection_failed"})
            return 1

        trading_class = str(_safe_attr(selected_chain, "tradingClass") or symbol).strip().upper()
        multiplier = str(_safe_attr(selected_chain, "multiplier") or "100").strip()
        expirations = _normalize_expirations(_safe_attr(selected_chain, "expirations"))
        strikes = _normalize_strikes(_safe_attr(selected_chain, "strikes"))

        expiration, requested_found = _pick_expiration(expirations, requested_expiration)
        if requested_expiration and not requested_found:
            warnings.append("requested_expiration_not_found_fallback_used")
        if expiration is None:
            _emit({**base, "connected": True, "error": "no_expiration_available"})
            return 1

        puts_strikes = [s for s in strikes if s <= underlying_price]
        if not puts_strikes:
            puts_strikes = sorted(strikes, key=lambda s: abs(s - underlying_price))
            warnings.append("no_strike_below_or_equal_underlying_used_nearest")
        sorted_by_proximity = sorted(puts_strikes, key=lambda s: abs(s - underlying_price))
        chosen = sorted_by_proximity[:max_strikes]
        chosen_strikes = sorted(chosen, reverse=True)
        if not chosen_strikes:
            _emit({**base, "connected": True, "error": "no_strikes_selected"})
            return 1

        option_rows = []
        option_tickers = []

        for strike in chosen_strikes:
            requested_option = Option(
                symbol=symbol,
                lastTradeDateOrContractMonth=expiration,
                strike=strike,
                right=right,
                exchange="SMART",
                currency=currency,
                multiplier="100",
                tradingClass=trading_class,
            )
            qualified_option = ib.qualifyContracts(requested_option)
            option_contract = None
            if isinstance(qualified_option, list) and qualified_option and qualified_option[0]:
                option_contract = qualified_option[0]

            if option_contract is None:
                warnings.append(f"option_not_qualified_strike_{strike}")
                option_rows.append(
                    {
                        "strike": strike,
                        "right": right,
                        "localSymbol": None,
                        "bid": None,
                        "ask": None,
                        "last": None,
                        "mid": None,
                        "spread": None,
                        "spreadPct": None,
                        "close": None,
                        "marketPrice": None,
                        "volume": None,
                    }
                )
                continue

            ticker = ib.reqMktData(option_contract, "", False, False)
            requested_contracts.append(option_contract)
            option_tickers.append((strike, option_contract, ticker))

        ib.sleep(5.0)

        for strike, option_contract, ticker in option_tickers:
            bid = _finite_number(_safe_attr(ticker, "bid"))
            ask = _finite_number(_safe_attr(ticker, "ask"))
            last = _finite_number(_safe_attr(ticker, "last"))
            close = _finite_number(_safe_attr(ticker, "close"))
            market_price = _extract_market_price(ticker)
            volume = _finite_number(_safe_attr(ticker, "volume"))
            mid = ((bid + ask) / 2) if bid is not None and ask is not None else None
            spread = (ask - bid) if bid is not None and ask is not None else None
            spread_pct = (spread / mid) if (spread is not None and mid not in (None, 0)) else None

            if bid is None or ask is None:
                warnings.append(f"missing_bid_ask_strike_{strike}")

            option_rows.append(
                {
                    "strike": strike,
                    "right": right,
                    "localSymbol": _safe_attr(option_contract, "localSymbol"),
                    "bid": bid,
                    "ask": ask,
                    "last": last,
                    "mid": mid,
                    "spread": spread,
                    "spreadPct": spread_pct,
                    "close": close,
                    "marketPrice": market_price,
                    "volume": volume,
                }
            )

        # Garder un ordre cohérent: strike décroissant.
        option_rows.sort(key=lambda r: (r.get("strike") is None, -(r.get("strike") or 0)))

        out = {
            "ok": True,
            "provider": "IBKR",
            "bridge": "ib_async",
            "mode": "readonly",
            "readOnly": True,
            "canTrade": False,
            "connected": True,
            "symbol": symbol,
            "marketDataType": market_data_type,
            "underlying": {
                "price": underlying_price,
                "bid": u_bid,
                "ask": u_ask,
                "last": u_last,
                "close": u_close,
                "conId": int(underlying_con_id),
                "timestamp": _timestamp_iso(underlying_ticker),
            },
            "selected": {
                "expiration": expiration,
                "tradingClass": trading_class,
                "multiplier": multiplier,
                "right": right,
                "strikes": chosen_strikes,
            },
            "options": option_rows,
            "warnings": sorted(set(warnings)),
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
        # CancelMktData pour tous les contrats demandés.
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
