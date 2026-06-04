"""
Batch read-only IBKR Shadow validation for Wheel safe/aggressive puts.

Deux modes d'exécution, choisis par IBKR_SCAN_CONCURRENCY (défaut 3, borné [1, 5]) :
  - concurrency == 1 : mode séquentiel partagé historique (une seule connexion
    TWS/Gateway pour tout le lot, traitement ticker par ticker). Comportement
    strictement équivalent à l'ancien batch.
  - concurrency  > 1 : mode concurrent borné. Chaque ticker est traité dans un
    sous-processus isolé qui lance le single scanner inchangé avec un clientId
    distinct (pool de taille = concurrency). Un ticker bloqué/timeout est tué
    sans bloquer les autres. La logique métier de sélection n'est pas modifiée.

Aucun ordre, aucun placeOrder, aucun cancelOrder, aucun positions.
"""
from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import sys
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


def _force_utf8_streams() -> None:
    """Force stdout/stderr en UTF-8 (Node lit le batch en UTF-8 ; défaut Windows = cp1252).

    Évite UnicodeEncodeError à l'émission du JSON final et le mojibake des accents.
    Bénéficie aux deux modes (séquentiel et concurrent).
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="backslashreplace")
            except Exception:
                pass


def _emit(payload: dict) -> None:
    try:
        print(json.dumps(payload, ensure_ascii=False))
    except UnicodeEncodeError:
        # Filet de sécurité ultime : ASCII pur (échappe tout non-ASCII), encodable partout.
        print(json.dumps(payload, ensure_ascii=True))


def _market_data_type_label(value) -> str:
    try:
        n = int(value)
    except (TypeError, ValueError):
        return "unknown"
    if n == 1:
        return "live"
    if n == 2:
        return "frozen"
    if n == 3:
        return "delayed"
    if n == 4:
        return "delayed_frozen"
    return "unknown"


def _utc_iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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
        "expectedMoveContractsRequested": 0,
        "putCandidateContractsRequested": 0,
        "putCandidateContractsActuallyRequested": 0,
        "putQuotesAvoidedByQuickGate": 0,
        "quickGateEvaluated": 0,
        "quickGateSkipped": 0,
        "quickGateFallback": 0,
        "quickGatePassed": 0,
        "quickGateRejected": 0,
        "quickGateSavedApproxCalls": 0,
        "cancelMarketDataCalls": 0,
        "marketDataWaits": 0,
        "timeouts": 0,
        "rawStrikesChecked": 0,
        "validCallStrikesCount": 0,
        "validPutStrikesCount": 0,
        "durationMs": 0,
        "approxIbkrCalls": 0,
        "totalApproxCalls": 0,
    }


def _empty_totals() -> dict:
    return {
        "totalStockQualifyCalls": 0,
        "totalOptionQualifyCalls": 0,
        "totalOptionChainRequests": 0,
        "totalStockMarketDataRequests": 0,
        "totalOptionMarketDataRequests": 0,
        "totalExpectedMoveOptionRequests": 0,
        "totalPutCandidateOptionRequests": 0,
        "totalExpectedMoveContractsRequested": 0,
        "totalPutCandidateContractsRequested": 0,
        "totalPutCandidateContractsActuallyRequested": 0,
        "totalPutQuotesAvoidedByQuickGate": 0,
        "totalQuickGateEvaluated": 0,
        "totalQuickGateSkipped": 0,
        "totalQuickGateFallback": 0,
        "totalQuickGatePassed": 0,
        "totalQuickGateRejected": 0,
        "totalQuickGateSavedApproxCalls": 0,
        "totalCancelMarketDataCalls": 0,
        "totalMarketDataWaits": 0,
        "totalTimeouts": 0,
        "totalRawStrikesChecked": 0,
        "totalValidCallStrikesCount": 0,
        "totalValidPutStrikesCount": 0,
        "totalApproxIbkrCalls": 0,
        "totalApproxCalls": 0,
        "totalDurationMs": 0,
        "totalTickersObserved": 0,
    }


def _resolve_scan_concurrency() -> int:
    """Concurrence du scan IBKR : défaut prudent 3, bornée [1, 5].

    Doit rester alignée avec resolveIbkrScanConcurrency() côté Node (app/config/ibkr.js).
    """
    n = _int_env("IBKR_SCAN_CONCURRENCY", 3)
    if n < 1:
        return 1
    if n > 5:
        return 5
    return n


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


def _perf_symbol_log(payload: dict) -> None:
    sym = payload.get("symbol")
    dur = payload.get("durationMs")
    if payload.get("reason") == "timeout":
        print(f"[IBKR PERF] symbol_timeout symbol={sym} durationMs={dur}", file=sys.stderr, flush=True)
    else:
        ok = bool(payload.get("ok"))
        print(f"[IBKR PERF] symbol_done symbol={sym} durationMs={dur} ok={ok}", file=sys.stderr, flush=True)


def _finalize_ticker_payload(
    symbol: str,
    payload: dict | None,
    exit_code: int | None,
    duration_ms: int,
    market_data_type: int,
    per_ticker_timeout_ms: int,
    apply_soft_timeout_label: bool = True,
) -> dict:
    """Normalise le payload d'un ticker (commun aux modes séquentiel et concurrent).

    Reproduit exactement la normalisation de l'ancienne boucle séquentielle :
    métadonnées, reason, détection de timeout post-hoc, ligne ibkrCallMetrics.

    apply_soft_timeout_label : en mode concurrent, un enfant qui a réellement terminé
    (exitCode connu) conserve sa vraie raison ; le timeout dur (kill) gère les vrais
    blocages. Le relabel soft basé sur per_ticker_timeout_ms ne sert qu'au mode
    séquentiel in-process (sans kill), où il reste actif par défaut.
    """
    if not isinstance(payload, dict):
        payload = {
            "ok": False,
            "provider": "IBKR",
            "mode": "ibkr_readonly_shadow",
            "symbol": symbol,
            "error": "ibkr_shadow_no_json_output",
        }
    payload["symbol"] = symbol
    payload["durationMs"] = duration_ms
    payload["twoPhaseEnabled"] = bool(payload.get("twoPhaseEnabled", False))
    payload["marketDataTypeRequested"] = market_data_type
    payload["marketDataTypeRequestedLabel"] = _market_data_type_label(market_data_type)
    if "marketDataTypeReceivedLabel" not in payload:
        payload["marketDataTypeReceivedLabel"] = "unknown"
    payload["scanCompletedAt"] = _utc_iso_now()
    if payload.get("ok") is not True:
        payload["reason"] = _reason_for_payload(payload)
        if apply_soft_timeout_label and payload["durationMs"] >= per_ticker_timeout_ms:
            payload["reason"] = "timeout"
            payload["error"] = payload.get("error") or "ibkr_shadow_ticker_timeout"
    if exit_code is not None and exit_code != 0 and payload.get("ok") is True:
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
    row_metrics["expectedMoveContractsRequested"] = int(
        row_metrics.get("expectedMoveContractsRequested", 0) or 0
    )
    row_metrics["putCandidateContractsRequested"] = int(
        row_metrics.get("putCandidateContractsRequested", 0) or 0
    )
    row_metrics["putCandidateContractsActuallyRequested"] = int(
        row_metrics.get(
            "putCandidateContractsActuallyRequested",
            row_metrics.get("putCandidateOptionRequests", 0),
        )
        or 0
    )
    row_metrics["totalApproxCalls"] = int(
        row_metrics.get("totalApproxCalls", row_metrics.get("approxIbkrCalls", 0)) or 0
    )
    if payload.get("reason") == "timeout":
        row_metrics["timeouts"] = int(row_metrics.get("timeouts", 0)) + 1
    payload["ibkrCallMetrics"] = row_metrics
    return payload


def _accumulate_into_totals(
    ibkr_totals: dict,
    ibkr_by_symbol: dict,
    symbol: str,
    payload: dict,
) -> None:
    row_metrics = payload.get("ibkrCallMetrics")
    if not isinstance(row_metrics, dict):
        row_metrics = _empty_ticker_metrics()
        payload["ibkrCallMetrics"] = row_metrics
    ibkr_by_symbol[symbol] = row_metrics

    ibkr_totals["totalStockQualifyCalls"] += int(row_metrics.get("stockQualifyCalls", 0) or 0)
    ibkr_totals["totalOptionQualifyCalls"] += int(row_metrics.get("optionQualifyCalls", 0) or 0)
    ibkr_totals["totalOptionChainRequests"] += int(row_metrics.get("optionChainRequests", 0) or 0)
    ibkr_totals["totalStockMarketDataRequests"] += int(row_metrics.get("stockMarketDataRequests", 0) or 0)
    ibkr_totals["totalOptionMarketDataRequests"] += int(row_metrics.get("optionMarketDataRequests", 0) or 0)
    ibkr_totals["totalExpectedMoveOptionRequests"] += int(row_metrics.get("expectedMoveOptionRequests", 0) or 0)
    ibkr_totals["totalPutCandidateOptionRequests"] += int(row_metrics.get("putCandidateOptionRequests", 0) or 0)
    ibkr_totals["totalExpectedMoveContractsRequested"] += int(
        row_metrics.get("expectedMoveContractsRequested", 0) or 0
    )
    ibkr_totals["totalPutCandidateContractsRequested"] += int(
        row_metrics.get("putCandidateContractsRequested", 0) or 0
    )
    ibkr_totals["totalPutCandidateContractsActuallyRequested"] += int(
        row_metrics.get("putCandidateContractsActuallyRequested", 0) or 0
    )
    ibkr_totals["totalPutQuotesAvoidedByQuickGate"] += int(
        row_metrics.get("putQuotesAvoidedByQuickGate", 0) or 0
    )
    ibkr_totals["totalQuickGateEvaluated"] += int(row_metrics.get("quickGateEvaluated", 0) or 0)
    ibkr_totals["totalQuickGateSkipped"] += int(row_metrics.get("quickGateSkipped", 0) or 0)
    ibkr_totals["totalQuickGateFallback"] += int(row_metrics.get("quickGateFallback", 0) or 0)
    ibkr_totals["totalQuickGatePassed"] += int(row_metrics.get("quickGatePassed", 0) or 0)
    ibkr_totals["totalQuickGateRejected"] += int(row_metrics.get("quickGateRejected", 0) or 0)
    ibkr_totals["totalQuickGateSavedApproxCalls"] += int(
        row_metrics.get("quickGateSavedApproxCalls", 0) or 0
    )
    ibkr_totals["totalCancelMarketDataCalls"] += int(row_metrics.get("cancelMarketDataCalls", 0) or 0)
    ibkr_totals["totalMarketDataWaits"] += int(row_metrics.get("marketDataWaits", 0) or 0)
    ibkr_totals["totalTimeouts"] += int(row_metrics.get("timeouts", 0) or 0)
    ibkr_totals["totalRawStrikesChecked"] += int(row_metrics.get("rawStrikesChecked", 0) or 0)
    ibkr_totals["totalValidCallStrikesCount"] += int(row_metrics.get("validCallStrikesCount", 0) or 0)
    ibkr_totals["totalValidPutStrikesCount"] += int(row_metrics.get("validPutStrikesCount", 0) or 0)
    ibkr_totals["totalApproxIbkrCalls"] += int(row_metrics.get("approxIbkrCalls", 0) or 0)
    ibkr_totals["totalApproxCalls"] += int(
        row_metrics.get("totalApproxCalls", row_metrics.get("approxIbkrCalls", 0)) or 0
    )
    ibkr_totals["totalDurationMs"] += int(row_metrics.get("durationMs", 0) or 0)
    ibkr_totals["totalTickersObserved"] += 1


def _emit_batch_payload(
    *,
    base: dict,
    results: list[dict],
    ibkr_totals: dict,
    ibkr_by_symbol: dict,
    symbols: list[str],
    two_phase_enabled: bool,
    market_data_type: int,
    per_ticker_timeout_ms: int,
    started: float,
    connected: bool,
    concurrency: int,
    concurrency_mode: str,
    max_active: int,
    wheel_dev_scan_batch: bool,
    quick_premium_gate_enabled: bool = False,
    extra: dict | None = None,
) -> dict:
    dev_displayed = sum(
        1 for row in results if isinstance(row, dict) and row.get("ibkrDevDisplay") is True
    )
    dev_incomplete = sum(
        1 for row in results if isinstance(row, dict) and row.get("devIncompleteMarketData") is True
    )
    ok_count = sum(1 for row in results if isinstance(row, dict) and row.get("ok") is True)
    timeout_count = sum(
        1 for row in results if isinstance(row, dict) and row.get("reason") == "timeout"
    )
    error_count = sum(
        1
        for row in results
        if isinstance(row, dict) and row.get("ok") is not True and row.get("reason") != "timeout"
    )
    total_dur_ms = round((time.monotonic() - started) * 1000)
    tickers_observed = max(1, ibkr_totals["totalTickersObserved"])
    avg_ticker_ms = (
        round(ibkr_totals["totalDurationMs"] / tickers_observed)
        if ibkr_totals["totalTickersObserved"] > 0
        else None
    )
    payload_out = {
        **base,
        "ok": True,
        "connected": connected,
        "twoPhaseEnabled": two_phase_enabled,
        "quickPremiumGateEnabled": bool(two_phase_enabled and quick_premium_gate_enabled),
        "ibkrMode": "TWO_PHASE" if two_phase_enabled else "NORMAL",
        "symbols": symbols,
        "total": len(symbols),
        "completed": len(results),
        "durationMs": total_dur_ms,
        "avgTickerDurationMs": avg_ticker_ms,
        "perTickerTimeoutMs": per_ticker_timeout_ms,
        "marketDataTypeRequested": market_data_type,
        "marketDataTypeRequestedLabel": _market_data_type_label(market_data_type),
        "scanCompletedAt": _utc_iso_now(),
        "concurrency": concurrency,
        "concurrencyMode": concurrency_mode,
        "maxActiveTasks": max_active,
        "okCount": ok_count,
        "timeoutCount": timeout_count,
        "errorCount": error_count,
        "ibkrCallMetrics": {
            "totals": ibkr_totals,
            "bySymbol": ibkr_by_symbol,
            "twoPhaseEnabled": two_phase_enabled,
            "quickPremiumGateEnabled": bool(two_phase_enabled and quick_premium_gate_enabled),
        },
        "results": results,
    }
    if isinstance(extra, dict):
        payload_out.update(extra)
    if wheel_dev_scan_batch:
        payload_out["devScanEnabled"] = True
        payload_out["dataTradable"] = False
        payload_out["devDisplayed"] = dev_displayed
        payload_out["devIncompleteTickers"] = dev_incomplete
    _emit(payload_out)
    print(
        f"[IBKR PERF] batch_done symbols={len(symbols)} ok={ok_count} timeout={timeout_count} "
        f"error={error_count} durationMs={total_dur_ms} concurrency={concurrency} maxActive={max_active}",
        file=sys.stderr,
        flush=True,
    )
    return payload_out


def _build_config() -> dict:
    wheel_dev_scan_batch = _parse_bool(os.environ.get("WHEEL_DEV_SCAN"), False)
    if wheel_dev_scan_batch:
        print("[WHEEL_DEV_SCAN] enabled=true", file=sys.stderr, flush=True)

    host = _str_env("IBKR_HOST", "127.0.0.1")
    port = _int_env("IBKR_PORT", 4002)
    client_id = _int_env("IBKR_CLIENT_ID", 300)
    read_only = _parse_bool(os.environ.get("IBKR_READ_ONLY"), True)
    market_data_type = _int_env("IBKR_MARKET_DATA_TYPE", 2)
    per_ticker_timeout_ms = max(1000, _int_env("IBKR_PER_TICKER_TIMEOUT_MS", 7000))
    underlying_wait = max(0.5, _float_env("IBKR_UNDERLYING_WAIT_SECONDS", 1.5))
    option_wait = max(1.0, _float_env("IBKR_OPTION_WAIT_SECONDS", 3.5))
    debug = _parse_bool(os.environ.get("DEBUG_IBKR"), False)
    two_phase_enabled = single._ibkr_two_phase_enabled()
    two_phase_put_window = max(
        1, _int_env("IBKR_TWO_PHASE_PUT_WINDOW", single.TWO_PHASE_DEFAULT_PUT_WINDOW)
    )
    single._log_ibkr_two_phase_config(two_phase_enabled, two_phase_put_window)
    quick_premium_gate_enabled = single._ibkr_quick_premium_gate_enabled()
    single._log_ibkr_quick_gate_config(quick_premium_gate_enabled)
    concurrency = _resolve_scan_concurrency()
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

    return {
        "wheel_dev_scan": wheel_dev_scan_batch,
        "host": host,
        "port": port,
        "client_id": client_id,
        "read_only": read_only,
        "market_data_type": market_data_type,
        "per_ticker_timeout_ms": per_ticker_timeout_ms,
        "underlying_wait": underlying_wait,
        "option_wait": option_wait,
        "debug": debug,
        "two_phase_enabled": two_phase_enabled,
        "two_phase_put_window": two_phase_put_window,
        "quick_premium_gate_enabled": quick_premium_gate_enabled,
        "concurrency": concurrency,
        "symbols": symbols,
        "base": base,
    }


def _run_sequential_shared(cfg: dict) -> int:
    """Mode historique : une seule connexion partagée, traitement ticker par ticker."""
    host = cfg["host"]
    port = cfg["port"]
    client_id = cfg["client_id"]
    market_data_type = cfg["market_data_type"]
    per_ticker_timeout_ms = cfg["per_ticker_timeout_ms"]
    underlying_wait = cfg["underlying_wait"]
    option_wait = cfg["option_wait"]
    debug = cfg["debug"]
    two_phase_enabled = cfg["two_phase_enabled"]
    quick_premium_gate_enabled = cfg["quick_premium_gate_enabled"]
    symbols = cfg["symbols"]
    base = cfg["base"]
    wheel_dev_scan_batch = cfg["wheel_dev_scan"]

    started = time.monotonic()
    print(
        f"[IBKR PERF] batch_start symbols={len(symbols)} concurrency=1 mode=sequential_shared",
        file=sys.stderr,
        flush=True,
    )

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
        results: list[dict] = []
        ibkr_by_symbol: dict[str, dict] = {}
        ibkr_totals = _empty_totals()
        for symbol in symbols:
            ticker_started = time.monotonic()
            previous_symbol = os.environ.get("IBKR_SYMBOL")
            previous_two_phase = os.environ.get("IBKR_TWO_PHASE_SCAN")
            os.environ["IBKR_SYMBOL"] = symbol
            os.environ["IBKR_TWO_PHASE_SCAN"] = "1" if two_phase_enabled else "0"
            try:
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    exit_code = single.main()
                duration_ms = round((time.monotonic() - ticker_started) * 1000)
                payload = _finalize_ticker_payload(
                    symbol,
                    _last_json_line(buf.getvalue()),
                    exit_code,
                    duration_ms,
                    market_data_type,
                    per_ticker_timeout_ms,
                )
                _accumulate_into_totals(ibkr_totals, ibkr_by_symbol, symbol, payload)
                results.append(payload)
                _perf_symbol_log(payload)
            except Exception as exc:
                duration_ms = round((time.monotonic() - ticker_started) * 1000)
                err = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
                if debug:
                    err = err + " | " + traceback.format_exc().replace("\n", " ")
                payload = _finalize_ticker_payload(
                    symbol,
                    {
                        "ok": False,
                        "provider": "IBKR",
                        "mode": "ibkr_readonly_shadow",
                        "symbol": symbol,
                        "error": err,
                    },
                    None,
                    duration_ms,
                    market_data_type,
                    per_ticker_timeout_ms,
                )
                _accumulate_into_totals(ibkr_totals, ibkr_by_symbol, symbol, payload)
                results.append(payload)
                _perf_symbol_log(payload)
            finally:
                if previous_symbol is None:
                    os.environ.pop("IBKR_SYMBOL", None)
                else:
                    os.environ["IBKR_SYMBOL"] = previous_symbol
                if previous_two_phase is None:
                    os.environ.pop("IBKR_TWO_PHASE_SCAN", None)
                else:
                    os.environ["IBKR_TWO_PHASE_SCAN"] = previous_two_phase

        _emit_batch_payload(
            base=base,
            results=results,
            ibkr_totals=ibkr_totals,
            ibkr_by_symbol=ibkr_by_symbol,
            symbols=symbols,
            two_phase_enabled=two_phase_enabled,
            market_data_type=market_data_type,
            per_ticker_timeout_ms=per_ticker_timeout_ms,
            started=started,
            connected=True,
            concurrency=1,
            concurrency_mode="sequential_shared",
            max_active=1,
            wheel_dev_scan_batch=wheel_dev_scan_batch,
            quick_premium_gate_enabled=quick_premium_gate_enabled,
        )
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


async def _run_one_subprocess(
    symbol: str,
    client_id: int,
    single_script: str,
    base_env: dict,
    market_data_type: int,
    per_ticker_timeout_ms: int,
    hard_timeout_s: float,
    debug: bool,
) -> dict:
    """Lance le single scanner inchangé dans un sous-processus isolé pour un symbole.

    Timeout dur : si le sous-processus dépasse hard_timeout_s, il est tué et le
    ticker est marqué en timeout sans bloquer les autres.
    """
    ticker_started = time.monotonic()
    env = dict(base_env)
    env["IBKR_SYMBOL"] = symbol
    env["IBKR_CLIENT_ID"] = str(client_id)
    print(
        f"[IBKR PERF] concurrent_child_start symbol={symbol} clientId={client_id}",
        file=sys.stderr,
        flush=True,
    )

    try:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            single_script,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=os.getcwd(),
        )
    except Exception as exc:
        duration_ms = round((time.monotonic() - ticker_started) * 1000)
        err = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        return _finalize_ticker_payload(
            symbol,
            {
                "ok": False,
                "provider": "IBKR",
                "mode": "ibkr_readonly_shadow",
                "symbol": symbol,
                "error": f"subprocess_spawn_failed: {err}",
            },
            None,
            duration_ms,
            market_data_type,
            per_ticker_timeout_ms,
        )

    try:
        stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=hard_timeout_s)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            proc.kill()
        with contextlib.suppress(Exception):
            await proc.wait()
        duration_ms = round((time.monotonic() - ticker_started) * 1000)
        return _finalize_ticker_payload(
            symbol,
            {
                "ok": False,
                "provider": "IBKR",
                "mode": "ibkr_readonly_shadow",
                "symbol": symbol,
                "error": "ibkr_shadow_ticker_timeout",
            },
            None,
            duration_ms,
            market_data_type,
            per_ticker_timeout_ms,
        )
    except Exception as exc:
        with contextlib.suppress(Exception):
            proc.kill()
            await proc.wait()
        duration_ms = round((time.monotonic() - ticker_started) * 1000)
        err = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
        return _finalize_ticker_payload(
            symbol,
            {
                "ok": False,
                "provider": "IBKR",
                "mode": "ibkr_readonly_shadow",
                "symbol": symbol,
                "error": err,
            },
            None,
            duration_ms,
            market_data_type,
            per_ticker_timeout_ms,
        )

    duration_ms = round((time.monotonic() - ticker_started) * 1000)
    exit_code = proc.returncode
    text = stdout_b.decode("utf-8", errors="replace") if stdout_b else ""
    stderr_text = stderr_b.decode("utf-8", errors="replace") if stderr_b else ""
    raw = _last_json_line(text)
    print(
        f"[IBKR PERF] concurrent_child_exit symbol={symbol} exitCode={exit_code} durationMs={duration_ms}",
        file=sys.stderr,
        flush=True,
    )
    if raw is None:
        print(f"[IBKR PERF] concurrent_child_no_json symbol={symbol}", file=sys.stderr, flush=True)
        tail = stderr_text[-300:].strip()
        if tail:
            print(
                f"[IBKR PERF] concurrent_child_stderr symbol={symbol} tail={tail!r}",
                file=sys.stderr,
                flush=True,
            )
    payload = _finalize_ticker_payload(
        symbol,
        raw,
        exit_code,
        duration_ms,
        market_data_type,
        per_ticker_timeout_ms,
        apply_soft_timeout_label=False,
    )
    if debug and stderr_text.strip():
        payload["_stderrTail"] = stderr_text[-400:]
    return payload


async def _run_concurrent(symbols: list[str], concurrency: int, cfg: dict) -> int:
    """Mode concurrent borné : un sous-processus isolé par symbole, clientId distinct.

    La concurrence est bornée par un pool de clientId de taille `concurrency`
    (sert simultanément de sémaphore et d'attribution de clientId sans collision).
    """
    base = cfg["base"]
    market_data_type = cfg["market_data_type"]
    per_ticker_timeout_ms = cfg["per_ticker_timeout_ms"]
    two_phase_enabled = cfg["two_phase_enabled"]
    quick_premium_gate_enabled = cfg["quick_premium_gate_enabled"]
    base_client_id = cfg["client_id"]
    debug = cfg["debug"]
    wheel_dev_scan_batch = cfg["wheel_dev_scan"]

    started = time.monotonic()
    # Timeout dur volontairement plus large que le timeout "soft" par ticker afin de
    # ne pas tuer un ticker légitimement lent (les attentes internes ~9s + connexion).
    hard_timeout_s = max(30.0, per_ticker_timeout_ms / 1000.0 + 8.0)
    single_script = os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "test_ibkr_async_wheel_safe_aggressive.py",
    )

    base_env = {
        **os.environ,
        "IBKR_READ_ONLY": "true",
        "IBKR_TWO_PHASE_SCAN": "1" if two_phase_enabled else "0",
        "IBKR_MARKET_DATA_TYPE": str(market_data_type),
        "IBKR_PER_TICKER_TIMEOUT_MS": str(per_ticker_timeout_ms),
        # Force le single sous-processus à écrire son JSON en UTF-8. Sinon il écrit
        # en cp1252 sous Windows -> octets invalides en UTF-8 -> '�' -> crash
        # à l'émission du JSON final du batch.
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
    }
    # Le single scanner ne lit qu'un symbole ; on retire toute liste de lot héritée.
    base_env.pop("IBKR_SYMBOLS_JSON", None)
    base_env.pop("IBKR_SYMBOLS", None)

    client_id_queue: asyncio.Queue = asyncio.Queue()
    for i in range(concurrency):
        client_id_queue.put_nowait(base_client_id + i)

    results_map: dict[str, dict] = {}
    state = {"active": 0, "max_active": 0}
    state_lock = asyncio.Lock()

    async def worker(symbol: str) -> None:
        cid = await client_id_queue.get()
        async with state_lock:
            state["active"] += 1
            if state["active"] > state["max_active"]:
                state["max_active"] = state["active"]
        try:
            payload = await _run_one_subprocess(
                symbol,
                cid,
                single_script,
                base_env,
                market_data_type,
                per_ticker_timeout_ms,
                hard_timeout_s,
                debug,
            )
        finally:
            async with state_lock:
                state["active"] -= 1
            client_id_queue.put_nowait(cid)
        results_map[symbol] = payload
        _perf_symbol_log(payload)

    print(
        f"[IBKR PERF] batch_start symbols={len(symbols)} concurrency={concurrency} "
        f"mode=concurrent_subprocess",
        file=sys.stderr,
        flush=True,
    )

    await asyncio.gather(*(worker(s) for s in symbols))

    # Préserve l'ordre d'entrée des symboles dans la sortie.
    results: list[dict] = []
    for s in symbols:
        payload = results_map.get(s)
        if payload is None:
            payload = _finalize_ticker_payload(
                s,
                {
                    "ok": False,
                    "provider": "IBKR",
                    "mode": "ibkr_readonly_shadow",
                    "symbol": s,
                    "error": "ibkr_shadow_no_result",
                },
                None,
                0,
                market_data_type,
                per_ticker_timeout_ms,
            )
        results.append(payload)

    ibkr_totals = _empty_totals()
    ibkr_by_symbol: dict[str, dict] = {}
    for payload in results:
        _accumulate_into_totals(ibkr_totals, ibkr_by_symbol, payload.get("symbol"), payload)

    connected = any(bool(r.get("ok")) or bool(r.get("connected")) for r in results)

    _emit_batch_payload(
        base=base,
        results=results,
        ibkr_totals=ibkr_totals,
        ibkr_by_symbol=ibkr_by_symbol,
        symbols=symbols,
        two_phase_enabled=two_phase_enabled,
        market_data_type=market_data_type,
        per_ticker_timeout_ms=per_ticker_timeout_ms,
        started=started,
        connected=connected,
        concurrency=concurrency,
        concurrency_mode="concurrent_subprocess",
        max_active=state["max_active"],
        wheel_dev_scan_batch=wheel_dev_scan_batch,
        quick_premium_gate_enabled=quick_premium_gate_enabled,
        extra={"clientIdRange": [base_client_id, base_client_id + concurrency - 1]},
    )
    print(
        f"[IBKR PERF] concurrent_batch_json_emitted symbols={len(symbols)}",
        file=sys.stderr,
        flush=True,
    )
    return 0


def main() -> int:
    _force_utf8_streams()
    cfg = _build_config()
    base = cfg["base"]
    symbols = cfg["symbols"]

    if not cfg["read_only"]:
        _emit({**base, "error": "IBKR_READ_ONLY doit être true pour ce batch (sécurité)."})
        return 1
    if not symbols:
        _emit({**base, "error": "missing_symbols", "results": []})
        return 1
    if len(symbols) > 50:
        _emit({**base, "error": "too_many_symbols", "results": []})
        return 1

    concurrency = cfg["concurrency"]
    # concurrency==1 (ou un seul symbole) : on garde le chemin partagé historique.
    if concurrency <= 1 or len(symbols) <= 1:
        return _run_sequential_shared(cfg)

    # Sous-processus asyncio : exige la ProactorEventLoop sous Windows.
    if sys.platform.startswith("win"):
        with contextlib.suppress(Exception):
            asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    return asyncio.run(_run_concurrent(symbols, concurrency, cfg))


if __name__ == "__main__":
    raise SystemExit(main())
