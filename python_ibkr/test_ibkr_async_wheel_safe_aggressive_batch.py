"""
Batch read-only IBKR Shadow validation for Wheel safe/aggressive puts.
Uses one TWS/Gateway connection for the whole batch.
Aucun ordre, aucun placeOrder, aucun cancelOrder, aucun positions.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import time
import traceback

from ib_async import IB
from ib_async.ib import StartupFetchNONE

import test_ibkr_async_wheel_safe_aggressive as single


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


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _parse_symbols() -> list[str]:
    raw_json = os.environ.get("IBKR_SYMBOLS_JSON", "")
    if raw_json.strip():
        try:
            data = json.loads(raw_json)
            if isinstance(data, list):
                return [str(x).strip().upper() for x in data if str(x).strip()]
        except Exception:
            pass
    raw = os.environ.get("IBKR_SYMBOLS", "")
    return [s.strip().upper() for s in raw.split(",") if s.strip()]


def _last_json_line(text: str) -> dict | None:
    for line in reversed(str(text or "").splitlines()):
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            return json.loads(s)
        except Exception:
            continue
    return None


def _reason_for_payload(payload: dict | None) -> str:
    error = str((payload or {}).get("error") or "").strip()
    if not error:
        return "ibkr_unavailable"
    if "timeout" in error.lower():
        return "timeout"
    if error in ("underlying_price_unavailable", "underlying_contract_not_qualified", "underlying_conid_missing"):
        return "no_market_data"
    if error in (
        "option_params_not_found",
        "option_chain_selection_failed",
        "no_expiration_available",
        "no_expiration_or_strikes",
        "no_strikes_selected",
    ):
        return "no_option_chain"
    if error in ("atm_straddle_unavailable", "expected_move_unavailable"):
        return "no_bid_ask"
    if error in ("invalid_bid", "invalid_ask", "invalid_mid"):
        return "no_bid_ask"
    return "ibkr_unavailable"


def _empty_ticker_metrics() -> dict:
    return {
        "stockQualifyCalls": 0,
        "optionQualifyCalls": 0,
        "optionChainRequests": 0,
        "stockMarketDataRequests": 0,
        "optionMarketDataRequests": 0,
        "expectedMoveOptionRequests": 0,
        "putCandidateOptionRequests": 0,
        "cancelMarketDataCalls": 0,
        "marketDataWaits": 0,
        "timeouts": 0,
        "rawStrikesChecked": 0,
        "validCallStrikesCount": 0,
        "validPutStrikesCount": 0,
        "durationMs": 0,
        "approxIbkrCalls": 0,
    }


class SharedIbProxy:
    def __init__(self, ib: IB, underlying_wait: float, option_wait: float):
        self._ib = ib
        self._underlying_wait = underlying_wait
        self._option_wait = option_wait

    def connect(self, *args, **kwargs):
        return None

    def disconnect(self):
        return None

    def isConnected(self):
        return self._ib.isConnected()

    def sleep(self, seconds):
        wait = float(seconds or 0)
        if wait >= 5:
            wait = min(wait, self._option_wait)
        elif wait >= 2:
            wait = min(wait, self._underlying_wait)
        return self._ib.sleep(wait)

    def __getattr__(self, name):
        return getattr(self._ib, name)


def main() -> int:
    host = _str_env("IBKR_HOST", "127.0.0.1")
    port = _int_env("IBKR_PORT", 4002)
    client_id = _int_env("IBKR_CLIENT_ID", 300)
    read_only = _parse_bool(os.environ.get("IBKR_READ_ONLY"), True)
    market_data_type = _int_env("IBKR_MARKET_DATA_TYPE", 2)
    per_ticker_timeout_ms = max(1000, _int_env("IBKR_PER_TICKER_TIMEOUT_MS", 7000))
    underlying_wait = max(0.5, _float_env("IBKR_UNDERLYING_WAIT_SECONDS", 1.5))
    option_wait = max(1.0, _float_env("IBKR_OPTION_WAIT_SECONDS", 3.5))
    debug = _parse_bool(os.environ.get("DEBUG_IBKR"), False)
    symbols = _parse_symbols()

    base = {
        "ok": False,
        "mode": "ibkr_readonly_shadow_batch",
        "provider": "IBKR",
        "bridge": "ib_async",
        "readOnly": True,
        "canTrade": False,
        "startupFetchDisabled": True,
        "connected": False,
        "clientId": client_id,
    }

    started = time.monotonic()
    if not read_only:
        _emit({**base, "error": "IBKR_READ_ONLY doit être true pour ce batch (sécurité)."})
        return 1
    if not symbols:
        _emit({**base, "error": "missing_symbols", "results": []})
        return 1
    if len(symbols) > 50:
        _emit({**base, "error": "too_many_symbols", "results": []})
        return 1

    ib = IB()
    original_ib_factory = single.IB
    proxy = SharedIbProxy(ib, underlying_wait=underlying_wait, option_wait=option_wait)

    try:
        ib.connect(
            host=host,
            port=port,
            clientId=client_id,
            timeout=6,
            readonly=True,
            fetchFields=StartupFetchNONE,
        )
        if not ib.isConnected():
            _emit({**base, "error": "Connexion refusée ou synchronisation incomplète", "results": []})
            return 1
        if hasattr(ib, "reqMarketDataType"):
            ib.reqMarketDataType(market_data_type)
        if hasattr(ib, "RequestTimeout"):
            ib.RequestTimeout = per_ticker_timeout_ms / 1000

        single.IB = lambda: proxy
        results = []
        ibkr_by_symbol = {}
        ibkr_totals = {
            "totalStockQualifyCalls": 0,
            "totalOptionQualifyCalls": 0,
            "totalOptionChainRequests": 0,
            "totalStockMarketDataRequests": 0,
            "totalOptionMarketDataRequests": 0,
            "totalExpectedMoveOptionRequests": 0,
            "totalPutCandidateOptionRequests": 0,
            "totalCancelMarketDataCalls": 0,
            "totalMarketDataWaits": 0,
            "totalTimeouts": 0,
            "totalRawStrikesChecked": 0,
            "totalValidCallStrikesCount": 0,
            "totalValidPutStrikesCount": 0,
            "totalApproxIbkrCalls": 0,
            "totalDurationMs": 0,
            "totalTickersObserved": 0,
        }
        for symbol in symbols:
            ticker_started = time.monotonic()
            previous_symbol = os.environ.get("IBKR_SYMBOL")
            os.environ["IBKR_SYMBOL"] = symbol
            try:
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    exit_code = single.main()
                payload = _last_json_line(buf.getvalue()) or {
                    "ok": False,
                    "provider": "IBKR",
                    "mode": "ibkr_readonly_shadow",
                    "symbol": symbol,
                    "error": "ibkr_shadow_no_json_output",
                }
                payload["symbol"] = symbol
                payload["durationMs"] = round((time.monotonic() - ticker_started) * 1000)
                if payload.get("ok") is not True:
                    payload["reason"] = _reason_for_payload(payload)
                    if payload["durationMs"] >= per_ticker_timeout_ms:
                        payload["reason"] = "timeout"
                        payload["error"] = payload.get("error") or "ibkr_shadow_ticker_timeout"
                if exit_code != 0 and payload.get("ok") is True:
                    payload["ok"] = False
                    payload["error"] = "ibkr_shadow_exit_nonzero"
                    payload["reason"] = "ibkr_unavailable"
                row_metrics = payload.get("ibkrCallMetrics") if isinstance(payload, dict) else None
                if not isinstance(row_metrics, dict):
                    row_metrics = _empty_ticker_metrics()
                else:
                    row_metrics = {
                        **_empty_ticker_metrics(),
                        **row_metrics,
                    }
                row_metrics["durationMs"] = payload.get("durationMs", row_metrics.get("durationMs", 0))
                if payload.get("reason") == "timeout":
                    row_metrics["timeouts"] = int(row_metrics.get("timeouts", 0)) + 1
                payload["ibkrCallMetrics"] = row_metrics
                ibkr_by_symbol[symbol] = row_metrics

                ibkr_totals["totalStockQualifyCalls"] += int(row_metrics.get("stockQualifyCalls", 0) or 0)
                ibkr_totals["totalOptionQualifyCalls"] += int(row_metrics.get("optionQualifyCalls", 0) or 0)
                ibkr_totals["totalOptionChainRequests"] += int(row_metrics.get("optionChainRequests", 0) or 0)
                ibkr_totals["totalStockMarketDataRequests"] += int(row_metrics.get("stockMarketDataRequests", 0) or 0)
                ibkr_totals["totalOptionMarketDataRequests"] += int(row_metrics.get("optionMarketDataRequests", 0) or 0)
                ibkr_totals["totalExpectedMoveOptionRequests"] += int(row_metrics.get("expectedMoveOptionRequests", 0) or 0)
                ibkr_totals["totalPutCandidateOptionRequests"] += int(row_metrics.get("putCandidateOptionRequests", 0) or 0)
                ibkr_totals["totalCancelMarketDataCalls"] += int(row_metrics.get("cancelMarketDataCalls", 0) or 0)
                ibkr_totals["totalMarketDataWaits"] += int(row_metrics.get("marketDataWaits", 0) or 0)
                ibkr_totals["totalTimeouts"] += int(row_metrics.get("timeouts", 0) or 0)
                ibkr_totals["totalRawStrikesChecked"] += int(row_metrics.get("rawStrikesChecked", 0) or 0)
                ibkr_totals["totalValidCallStrikesCount"] += int(row_metrics.get("validCallStrikesCount", 0) or 0)
                ibkr_totals["totalValidPutStrikesCount"] += int(row_metrics.get("validPutStrikesCount", 0) or 0)
                ibkr_totals["totalApproxIbkrCalls"] += int(row_metrics.get("approxIbkrCalls", 0) or 0)
                ibkr_totals["totalDurationMs"] += int(row_metrics.get("durationMs", 0) or 0)
                ibkr_totals["totalTickersObserved"] += 1
                results.append(payload)
            except Exception as exc:
                duration_ms = round((time.monotonic() - ticker_started) * 1000)
                err = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
                if debug:
                    err = err + " | " + traceback.format_exc().replace("\n", " ")
                results.append({
                    "ok": False,
                    "provider": "IBKR",
                    "mode": "ibkr_readonly_shadow",
                    "symbol": symbol,
                    "error": err,
                    "reason": "timeout" if duration_ms >= per_ticker_timeout_ms else "ibkr_unavailable",
                    "durationMs": duration_ms,
                    "ibkrCallMetrics": {
                        **_empty_ticker_metrics(),
                        "durationMs": duration_ms,
                        "timeouts": 1 if duration_ms >= per_ticker_timeout_ms else 0,
                    },
                })
                row_metrics = results[-1]["ibkrCallMetrics"]
                row_metrics["approxIbkrCalls"] = int(
                    row_metrics.get("stockQualifyCalls", 0)
                    + row_metrics.get("optionQualifyCalls", 0)
                    + row_metrics.get("optionChainRequests", 0)
                    + row_metrics.get("stockMarketDataRequests", 0)
                    + row_metrics.get("optionMarketDataRequests", 0)
                    + row_metrics.get("cancelMarketDataCalls", 0)
                )
                ibkr_by_symbol[symbol] = row_metrics
                ibkr_totals["totalTimeouts"] += int(row_metrics.get("timeouts", 0) or 0)
                ibkr_totals["totalDurationMs"] += int(row_metrics.get("durationMs", 0) or 0)
                ibkr_totals["totalApproxIbkrCalls"] += int(row_metrics.get("approxIbkrCalls", 0) or 0)
                ibkr_totals["totalTickersObserved"] += 1
            finally:
                if previous_symbol is None:
                    os.environ.pop("IBKR_SYMBOL", None)
                else:
                    os.environ["IBKR_SYMBOL"] = previous_symbol

        _emit({
            **base,
            "ok": True,
            "connected": True,
            "symbols": symbols,
            "total": len(symbols),
            "completed": len(results),
            "durationMs": round((time.monotonic() - started) * 1000),
            "perTickerTimeoutMs": per_ticker_timeout_ms,
            "ibkrCallMetrics": {
                "totals": ibkr_totals,
                "bySymbol": ibkr_by_symbol,
            },
            "results": results,
        })
        return 0
    except Exception as exc:
        err = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        if debug:
            err = err + " | " + traceback.format_exc().replace("\n", " ")
        _emit({**base, "connected": bool(getattr(ib, "isConnected", lambda: False)()), "error": err, "results": []})
        return 1
    finally:
        single.IB = original_ib_factory
        try:
            if ib.isConnected():
                ib.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
