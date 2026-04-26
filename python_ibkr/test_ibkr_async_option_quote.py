"""
Smoke test: lecture d'une quote option via ib_async (lecture seule, aucun ordre).
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


def _float_env(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or str(raw).strip() == "":
        return default
    try:
        return float(str(raw).strip())
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


def _safe_attr(obj, name: str):
    try:
        return getattr(obj, name, None)
    except Exception:
        return None


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


def main() -> int:
    host = _str_env("IBKR_HOST", "127.0.0.1")
    port = _int_env("IBKR_PORT", 4002)
    client_id = _int_env("IBKR_CLIENT_ID", 203)
    read_only = _parse_bool(os.environ.get("IBKR_READ_ONLY"), True)
    market_data_type = _int_env("IBKR_MARKET_DATA_TYPE", 3)

    symbol = _str_env("IBKR_SYMBOL", "SPY").upper()
    expiration = _str_env("IBKR_OPTION_EXPIRATION", "20260501")
    strike = _float_env("IBKR_OPTION_STRIKE", 700.0)
    right = _str_env("IBKR_OPTION_RIGHT", "P").upper()
    exchange = _str_env("IBKR_EXCHANGE", "SMART").upper()
    currency = _str_env("IBKR_CURRENCY", "USD").upper()
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
        from ib_async import IB, Option
    except ImportError as e:
        _emit({**base, "error": f"Import ib_async impossible: {e!s}"})
        return 1

    fetch_fields = _resolve_fetch_fields_none()
    ib = IB()
    contract = None
    market_data_requested = False

    try:
        connect_kw = {
            "host": host,
            "port": port,
            "clientId": client_id,
            "timeout": 5,
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

        contract = Option(symbol, expiration, strike, right, exchange, currency)
        qualified = ib.qualifyContracts(contract)
        qualified_contract = None
        if isinstance(qualified, list) and qualified:
            qualified_contract = qualified[0]

        sec_type = _safe_attr(qualified_contract, "secType")
        con_id = _safe_attr(qualified_contract, "conId")
        has_contract_identity = bool(sec_type) or (
            isinstance(con_id, int) and con_id > 0
        )

        if qualified_contract is None or not has_contract_identity:
            _emit(
                {
                    **base,
                    "connected": bool(ib.isConnected()),
                    "contract": {
                        "secType": "OPT",
                        "lastTradeDateOrContractMonth": expiration,
                        "strike": strike,
                        "right": right,
                        "exchange": exchange,
                        "currency": currency,
                    },
                    "error": "option_contract_not_qualified",
                }
            )
            return 1
        contract = qualified_contract

        if hasattr(ib, "reqMarketDataType"):
            ib.reqMarketDataType(market_data_type)

        ticker = ib.reqMktData(contract, "", False, False)
        market_data_requested = True
        ib.sleep(3.0)

        quote = {
            "bid": _finite_number(_safe_attr(ticker, "bid")),
            "ask": _finite_number(_safe_attr(ticker, "ask")),
            "last": _finite_number(_safe_attr(ticker, "last")),
            "close": _finite_number(_safe_attr(ticker, "close")),
            "marketPrice": _extract_market_price(ticker),
            "volume": _finite_number(_safe_attr(ticker, "volume")),
            "timestamp": _timestamp_iso(ticker),
        }

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
            "contract": {
                "secType": _safe_attr(contract, "secType") or "OPT",
                "lastTradeDateOrContractMonth": _safe_attr(contract, "lastTradeDateOrContractMonth")
                or expiration,
                "strike": _finite_number(_safe_attr(contract, "strike")) or strike,
                "right": _safe_attr(contract, "right") or right,
                "exchange": _safe_attr(contract, "exchange") or exchange,
                "currency": _safe_attr(contract, "currency") or currency,
            },
            "quote": quote,
        }
        _emit(out)
        return 0

    except Exception as e:
        err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        if debug:
            err = err + " | " + traceback.format_exc().replace("\n", " ")
        _emit({**base, "error": err})
        return 1
    finally:
        try:
            if market_data_requested and contract is not None and ib.isConnected():
                ib.cancelMktData(contract)
        except Exception:
            pass
        try:
            if ib.isConnected():
                ib.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
