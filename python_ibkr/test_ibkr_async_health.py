"""
Smoke test: connexion TWS/IB Gateway via ib_async (lecture seule, aucun ordre).
Ne demande pas positions, compte, ordres ni exécutions (fetchFields=StartupFetchNONE si dispo).
"""
from __future__ import annotations

import json
import os
import sys
import traceback


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
    """Évite le chargement des snapshots compte/positions/ordres au connect, si l'API l'expose."""
    try:
        from ib_async.ib import StartupFetchNONE  # type: ignore[attr-defined]

        return StartupFetchNONE
    except (ImportError, AttributeError):
        return None


def _emit(base: dict, **extra) -> None:
    out = {**base, **extra}
    print(json.dumps(out, ensure_ascii=False))


def main() -> int:
    host = _str_env("IBKR_HOST", "127.0.0.1")
    port = _int_env("IBKR_PORT", 7497)
    client_id = _int_env("IBKR_CLIENT_ID", 201)
    read_only = _parse_bool(os.environ.get("IBKR_READ_ONLY"), True)

    base = {
        "ok": False,
        "provider": "IBKR",
        "bridge": "ib_async",
        "mode": "readonly",
        "readOnly": read_only,
        "canTrade": False,
        "connected": False,
        "host": host,
        "port": port,
        "clientId": client_id,
    }

    if not read_only:
        _emit(base, error="IBKR_READ_ONLY doit être true pour ce test (sécurité).")
        return 1

    try:
        from ib_async import IB
    except ImportError as e:
        _emit(
            base,
            error=f"Import ib_async impossible: {e!s}",
        )
        return 1

    fetch_fields = _resolve_fetch_fields_none()
    ib = IB()

    try:
        connect_kw: dict = {
            "host": host,
            "port": port,
            "clientId": client_id,
            "timeout": 5,
            "readonly": True,
        }
        if fetch_fields is not None:
            connect_kw["fetchFields"] = fetch_fields

        ib.connect(**connect_kw)

        if not ib.isConnected():
            _emit(base, error="Connexion refusée ou synchronisation incomplète (isConnected() == false).")
            return 1

        out = {**base, "ok": True, "connected": True, "readOnly": True, "canTrade": False}
        print(json.dumps(out, ensure_ascii=False))
        return 0

    except Exception as e:
        err = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        # Pas de stacktrace en stdout: JSON propre; détail seulement si DEBUG_IBKR=1
        if _parse_bool(os.environ.get("DEBUG_IBKR"), False):
            err = err + " | " + traceback.format_exc().replace("\n", " ")
        _emit(base, error=err)
        return 1
    finally:
        try:
            if ib.isConnected():
                ib.disconnect()
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
