"""
Smoke test: paramètres de chaînes d'options via reqSecDefOptParams (lecture seule, aucun market data, aucun ordre).
"""
from __future__ import annotations

import json
import os
import traceback
from datetime import date, datetime

MAX_SAMPLE_EXPIRATIONS = 2
MAX_SAMPLE_STRIKES = 3


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


def _format_expiration_item(item) -> str:
    if item is None:
        return ""
    if isinstance(item, (datetime, date)):
        return item.strftime("%Y%m%d")
    s = str(item).strip()
    if len(s) == 8 and s.isdigit():
        return s
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            d = datetime.strptime(s, fmt)
            return d.strftime("%Y%m%d")
        except ValueError:
            continue
    return s


def _normalize_expirations(raw) -> list[str]:
    if raw is None:
        return []
    it = list(raw) if not isinstance(raw, (str, bytes)) else [raw]
    out = []
    for x in it:
        f = _format_expiration_item(x)
        if f and f not in out:
            out.append(f)
    return sorted(out)


def _normalize_strikes(raw) -> list[float]:
    if raw is None:
        return []
    it = list(raw) if not isinstance(raw, (str, int, float)) else [raw]
    out = []
    for x in it:
        try:
            f = float(x)
        except (TypeError, ValueError):
            continue
        out.append(f)
    return sorted(set(out))


def main() -> int:
    host = _str_env("IBKR_HOST", "127.0.0.1")
    port = _int_env("IBKR_PORT", 4002)
    client_id = _int_env("IBKR_CLIENT_ID", 204)
    read_only = _parse_bool(os.environ.get("IBKR_READ_ONLY"), True)
    symbol = _str_env("IBKR_SYMBOL", "SPY").upper()
    exchange = _str_env("IBKR_EXCHANGE", "SMART").upper()
    currency = _str_env("IBKR_CURRENCY", "USD").upper()
    sec_type = _str_env("IBKR_SEC_TYPE", "STK").upper()
    option_params_exchange = os.environ.get("IBKR_OPTION_PARAMS_EXCHANGE", "")
    if option_params_exchange is None:
        option_params_exchange = ""
    option_params_exchange = str(option_params_exchange).strip().upper()
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
        "host": host,
        "port": port,
        "clientId": client_id,
    }

    if not read_only:
        _emit({**base, "error": "IBKR_READ_ONLY doit être true pour ce test (sécurité)."})
        return 1

    try:
        from ib_async import IB, Contract, Stock
    except ImportError as e:
        _emit({**base, "error": f"Import ib_async impossible: {e!s}"})
        return 1

    fetch_fields = _resolve_fetch_fields_none()
    ib = IB()

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

        if sec_type == "STK":
            stock = Stock(symbol, exchange, currency)
        else:
            stock = Contract(
                symbol=symbol,
                secType=sec_type,
                exchange=exchange,
                currency=currency,
            )
        qualified = ib.qualifyContracts(stock)
        qc = None
        if isinstance(qualified, list) and qualified:
            qc = qualified[0]

        con_id = _safe_attr(qc, "conId")
        st = _safe_attr(qc, "secType")
        if (
            qc is None
            or not (isinstance(con_id, int) and con_id > 0)
            or not st
        ):
            _emit(
                {
                    **base,
                    "connected": bool(ib.isConnected()),
                    "error": "underlying_contract_not_qualified",
                }
            )
            return 1

        # (underlyingSymbol, futFopExchange, underlyingSecType, underlyingConId)
        underlying_con_id = int(con_id)
        opt_params = ib.reqSecDefOptParams(
            symbol,
            option_params_exchange,
            sec_type,
            underlying_con_id,
        )
        if opt_params is None:
            opt_params = []

        option_params_out: list[dict] = []
        for chain in opt_params:
            ex = _safe_attr(chain, "exchange")
            tc = _safe_attr(chain, "tradingClass")
            mult = _safe_attr(chain, "multiplier")
            expirations = _normalize_expirations(_safe_attr(chain, "expirations"))
            strikes = _normalize_strikes(_safe_attr(chain, "strikes"))
            mult_out = None
            if mult is not None and str(mult).strip() != "":
                mult_out = str(mult).strip()
            option_params_out.append(
                {
                    "exchange": ex,
                    "tradingClass": tc,
                    "multiplier": mult_out,
                    "expirationsCount": len(expirations),
                    "strikesCount": len(strikes),
                    "expirationsSample": expirations[:MAX_SAMPLE_EXPIRATIONS],
                    "strikesSample": strikes[:MAX_SAMPLE_STRIKES],
                }
            )

        out = {
            "ok": True,
            "provider": "IBKR",
            "bridge": "ib_async",
            "mode": "readonly",
            "readOnly": True,
            "canTrade": False,
            "connected": True,
            "symbol": symbol,
            "underlying": {
                "conId": int(con_id),
                "secType": st,
                "exchange": _safe_attr(qc, "exchange") or exchange,
                "currency": _safe_attr(qc, "currency") or currency,
            },
            "request": {
                "underlyingExchange": exchange,
                "optionParamsExchange": option_params_exchange,
                "underlyingSecType": sec_type,
                "underlyingConId": underlying_con_id,
            },
            "optionParams": option_params_out,
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
                ib.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
