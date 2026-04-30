"""
Diagnostic isolé IBKR (1 ticker): comparaison méthode actuelle vs méthode 2-phases.

Ce script NE modifie pas le scanner principal.
Il n'envoie aucun ordre (read-only uniquement).
"""
from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

from ib_async import IB, Option, Stock
from ib_async.ib import StartupFetchNONE

W_ATM = 0.60
W_S1 = 0.30
W_S2 = 0.10
MIN_PREMIUM_YIELD = 0.005
EM_FALLBACK_WINDOW = 3


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


def _safe_attr(obj, name: str):
    try:
        return getattr(obj, name, None)
    except Exception:
        return None


def _round_money_half_up(value: float | int | str) -> float:
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


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


def _pick_chain(chains, symbol: str):
    if not chains:
        return None
    upper_symbol = symbol.upper()

    def _norm(v):
        return str(v or "").strip().upper()

    preferred = []
    fallback = []
    for c in chains:
        ex = _norm(_safe_attr(c, "exchange"))
        tc = _norm(_safe_attr(c, "tradingClass"))
        mult = str(_safe_attr(c, "multiplier") or "").strip()
        is_sym = tc == upper_symbol
        is_100 = mult == "100"
        if ex == "SMART" and is_sym and is_100:
            preferred.append(c)
        elif is_sym:
            fallback.append(c)
    if preferred:
        return preferred[0]
    if fallback:
        return fallback[0]
    return chains[0]


def _nearest_atm_index(strikes: list[float], price: float) -> int:
    if not strikes:
        return 0
    return min(range(len(strikes)), key=lambda i: abs(strikes[i] - price))


def _conservative_premium(bid, ask, last, close):
    if bid is not None and ask is not None and ask >= bid and bid > 0:
        return (bid + ask) / 2
    if last is not None and last > 0:
        return last
    if bid is not None and bid > 0:
        return bid
    if close is not None and close > 0:
        return close
    return None


def _leg_quotes(ticker):
    bid = _finite_number(_safe_attr(ticker, "bid"))
    ask = _finite_number(_safe_attr(ticker, "ask"))
    last = _finite_number(_safe_attr(ticker, "last"))
    close = _finite_number(_safe_attr(ticker, "close"))
    mid = (bid + ask) / 2 if bid is not None and ask is not None else None
    spread = (ask - bid) if bid is not None and ask is not None else None
    spread_pct = (spread / mid) if (spread is not None and mid and mid > 0) else None
    prime_used = _conservative_premium(bid, ask, last, close)
    return {
        "bid": bid,
        "ask": ask,
        "last": last,
        "close": close,
        "mid": mid,
        "spread": spread,
        "spreadPct": spread_pct,
        "primeUsed": prime_used,
    }


def _put_quotes(ticker):
    bid = _finite_number(_safe_attr(ticker, "bid"))
    ask = _finite_number(_safe_attr(ticker, "ask"))
    last = _finite_number(_safe_attr(ticker, "last"))
    close = _finite_number(_safe_attr(ticker, "close"))
    mid = (bid + ask) / 2 if bid is not None and ask is not None else None
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
        "primeUsed": bid,  # règle Wheel conservatrice
    }


def _last_json_line(text: str):
    for line in reversed(str(text or "").splitlines()):
        s = line.strip()
        if not s.startswith("{"):
            continue
        try:
            return json.loads(s)
        except Exception:
            continue
    return None


def _run_method_a_via_subprocess(symbol: str, expiration: str, client_id: int):
    script_path = Path(__file__).with_name("test_ibkr_async_wheel_safe_aggressive.py")
    env = {
        **os.environ,
        "IBKR_READ_ONLY": "true",
        "IBKR_SYMBOL": symbol,
        "IBKR_OPTION_EXPIRATION": expiration,
        "IBKR_CLIENT_ID": str(client_id),
        "IBKR_MARKET_DATA_TYPE": "2",
        "IBKR_MAX_STRIKES": "25",
    }
    proc = subprocess.run(
        [sys.executable, str(script_path)],
        capture_output=True,
        text=True,
        env=env,
        cwd=str(Path(__file__).resolve().parents[1]),
        check=False,
    )
    payload = _last_json_line(proc.stdout) or {
        "ok": False,
        "error": "no_json_output",
        "stdout": proc.stdout[-4000:],
        "stderr": proc.stderr[-4000:],
        "exitCode": proc.returncode,
    }
    return payload


@dataclass
class Metrics:
    stock_qualify: int = 0
    option_qualify: int = 0
    option_chain: int = 0
    stock_mktdata: int = 0
    option_mktdata: int = 0
    expected_move_contracts_requested: int = 0
    put_contracts_requested: int = 0

    def approx_calls(self) -> int:
        return (
            self.stock_qualify
            + self.option_qualify
            + self.option_chain
            + self.stock_mktdata
            + self.option_mktdata
        )


def _run_method_b_two_phase(symbol: str, expiration: str, safe_window: int, client_id: int):
    ib = IB()
    metrics = Metrics()
    qualified_option_keys = set()
    option_quote_samples = []
    try:
        ib.connect(
            host=os.environ.get("IBKR_HOST", "127.0.0.1"),
            port=int(os.environ.get("IBKR_PORT", "4002")),
            clientId=client_id,
            timeout=6,
            readonly=True,
            fetchFields=StartupFetchNONE,
        )
        if not ib.isConnected():
            return {"ok": False, "reason": "ibkr_connection_failed"}
        if hasattr(ib, "reqMarketDataType"):
            ib.reqMarketDataType(2)

        # Underlying
        underlying = Stock(symbol, "SMART", "USD")
        metrics.stock_qualify += 1
        uq = ib.qualifyContracts(underlying)
        if not (isinstance(uq, list) and uq and uq[0]):
            return {"ok": False, "reason": "underlying_contract_not_qualified"}
        underlying = uq[0]
        con_id = _safe_attr(underlying, "conId")
        if con_id is None:
            return {"ok": False, "reason": "underlying_conid_missing"}
        metrics.stock_mktdata += 1
        u_tk = ib.reqMktData(underlying, "", False, False)
        ib.sleep(2.0)
        spot = (
            _finite_number(_safe_attr(u_tk, "marketPrice")() if callable(_safe_attr(u_tk, "marketPrice")) else _safe_attr(u_tk, "marketPrice"))
            or _finite_number(_safe_attr(u_tk, "last"))
            or ((_finite_number(_safe_attr(u_tk, "bid")) or 0) + (_finite_number(_safe_attr(u_tk, "ask")) or 0)) / 2
        )
        if not (spot and spot > 0):
            return {"ok": False, "reason": "underlying_price_unavailable"}

        # Chain
        metrics.option_chain += 1
        chains = list(ib.reqSecDefOptParams(symbol, "", "STK", int(con_id)) or [])
        if not chains:
            return {"ok": False, "reason": "no_option_chain"}
        chain = _pick_chain(chains, symbol)
        if chain is None:
            return {"ok": False, "reason": "no_option_chain"}
        expirations = _normalize_expirations(_safe_attr(chain, "expirations"))
        strikes = _normalize_strikes(_safe_attr(chain, "strikes"))
        if not expirations or not strikes:
            return {"ok": False, "reason": "no_option_chain"}
        if expiration not in expirations:
            future = [e for e in expirations if e >= expiration]
            expiration_used = future[0] if future else expirations[0]
        else:
            expiration_used = expiration
        trading_class = str(_safe_attr(chain, "tradingClass") or symbol).strip().upper()

        def option_contract(strike: float, right: str):
            return Option(
                symbol=symbol,
                lastTradeDateOrContractMonth=expiration_used,
                strike=float(strike),
                right=right,
                exchange="SMART",
                currency="USD",
                multiplier="100",
                tradingClass=trading_class,
            )

        def qualify_option(strike: float, right: str):
            c = option_contract(strike, right)
            metrics.option_qualify += 1
            out = ib.qualifyContracts(c)
            if isinstance(out, list) and out and out[0]:
                q = out[0]
                key = f"{right}:{float(strike):.4f}:{_safe_attr(q, 'localSymbol')}"
                qualified_option_keys.add(key)
                return q
            return None

        atm_idx = _nearest_atm_index(strikes, float(spot))
        atm_strike = strikes[atm_idx]

        def pick_leg(target_idx: int, right: str):
            candidates = []
            for delta in range(-EM_FALLBACK_WINDOW, EM_FALLBACK_WINDOW + 1):
                idx = target_idx + delta
                if 0 <= idx < len(strikes):
                    candidates.append((abs(delta), idx))
            candidates.sort(key=lambda x: x[0])
            for _, idx in candidates:
                st = strikes[idx]
                qc = qualify_option(st, right)
                if qc is not None:
                    return st, qc
            return None, None

        em_legs = []
        for target_idx, right, role in [
            (atm_idx, "C", "atm_call"),
            (atm_idx, "P", "atm_put"),
            (atm_idx + 1, "C", "strangle1_call"),
            (atm_idx - 1, "P", "strangle1_put"),
            (atm_idx + 2, "C", "strangle2_call"),
            (atm_idx - 2, "P", "strangle2_put"),
        ]:
            st, qc = pick_leg(target_idx, right)
            if st is not None and qc is not None:
                em_legs.append((role, right, st, qc))
                metrics.expected_move_contracts_requested += 1

        def req_option_quote(contract, quote_kind: str):
            metrics.option_mktdata += 1
            tk = ib.reqMktData(contract, "", False, False)
            option_quote_samples.append({"kind": quote_kind, "ticker": tk})
            return tk

        leg_tickers = {}
        for role, right, st, qc in em_legs:
            leg_tickers[(role, right, st)] = req_option_quote(qc, "expected_move")
        ib.sleep(5.0)

        def leg_price(role: str, right: str, strike: float):
            tk = leg_tickers.get((role, right, strike))
            if tk is None:
                return None
            return _leg_quotes(tk)["primeUsed"]

        em_map = {(r, rt): (st, c) for r, rt, st, c in em_legs}
        if ("atm_call", "C") not in em_map or ("atm_put", "P") not in em_map:
            return {"ok": False, "reason": "no_expected_move_contracts"}

        atm_call_strike = em_map[("atm_call", "C")][0]
        atm_put_strike = em_map[("atm_put", "P")][0]
        p_atm_c = leg_price("atm_call", "C", atm_call_strike)
        p_atm_p = leg_price("atm_put", "P", atm_put_strike)
        if p_atm_c is None or p_atm_p is None:
            return {"ok": False, "reason": "no_bid_ask"}
        atm_straddle = p_atm_c + p_atm_p

        s1_val = None
        if ("strangle1_call", "C") in em_map and ("strangle1_put", "P") in em_map:
            st1c = em_map[("strangle1_call", "C")][0]
            st1p = em_map[("strangle1_put", "P")][0]
            p1c = leg_price("strangle1_call", "C", st1c)
            p1p = leg_price("strangle1_put", "P", st1p)
            if p1c is not None and p1p is not None:
                s1_val = p1c + p1p
        s2_val = None
        if ("strangle2_call", "C") in em_map and ("strangle2_put", "P") in em_map:
            st2c = em_map[("strangle2_call", "C")][0]
            st2p = em_map[("strangle2_put", "P")][0]
            p2c = leg_price("strangle2_call", "C", st2c)
            p2p = leg_price("strangle2_put", "P", st2p)
            if p2c is not None and p2p is not None:
                s2_val = p2c + p2p

        parts = [(W_ATM, atm_straddle)]
        if s1_val is not None:
            parts.append((W_S1, s1_val))
        if s2_val is not None:
            parts.append((W_S2, s2_val))
        w_sum = sum(w for w, _ in parts)
        if w_sum <= 0:
            return {"ok": False, "reason": "no_bid_ask"}
        expected_move = sum(w * v for w, v in parts) / w_sum
        lower_bound = float(spot) - expected_move
        upper_bound = float(spot) + expected_move

        # Phase 2 puts candidats
        puts_below_or_at = [s for s in strikes if s <= float(spot)]
        puts_below_or_at.sort(reverse=True)
        below_lower = [s for s in puts_below_or_at if s < lower_bound]
        if not below_lower:
            return {
                "ok": False,
                "reason": "no_put_candidates_under_lower_bound",
                "spot": spot,
                "atmStrike": atm_strike,
                "expectedMove": expected_move,
                "lowerBound": lower_bound,
                "upperBound": upper_bound,
                "targetPremium": _round_money_half_up(float(spot) * MIN_PREMIUM_YIELD),
                "metrics": metrics.__dict__,
            }
        aggressive_ref = below_lower[0]
        lower_candidates = [s for s in puts_below_or_at if s < aggressive_ref]
        chosen_put_strikes = [aggressive_ref, *lower_candidates[:safe_window]]

        put_rows = []
        for st in chosen_put_strikes:
            qc = qualify_option(st, "P")
            if qc is None:
                continue
            metrics.put_contracts_requested += 1
            tk = req_option_quote(qc, "put_candidate")
            put_rows.append((st, tk))
        ib.sleep(5.0)

        target_premium_raw = float(spot) * MIN_PREMIUM_YIELD
        target_premium = _round_money_half_up(target_premium_raw)
        put_data = []
        for st, tk in put_rows:
            q = _put_quotes(tk)
            bid = q["bid"]
            mid = q["mid"]
            prime_used = q["primeUsed"]
            weekly_yield = ((prime_used / st) if (prime_used is not None and st and st > 0) else None)
            passes_min = bool(prime_used is not None and prime_used >= target_premium)
            is_below = bool(st < lower_bound)
            distance_below = (lower_bound - st) if is_below else None
            if not is_below:
                status, reason = "rejected", "above_or_equal_lower_bound"
            elif bid is None:
                status, reason = "rejected", "invalid_bid"
            elif q["ask"] is None:
                status, reason = "rejected", "invalid_ask"
            elif mid is None or mid <= 0:
                status, reason = "rejected", "invalid_mid"
            elif not passes_min:
                status, reason = "rejected", "premium_below_min"
            else:
                status, reason = "kept", "passes_min_premium"
            put_data.append(
                {
                    "strike": st,
                    "bid": bid,
                    "ask": q["ask"],
                    "mid": mid,
                    "primeUsed": prime_used,
                    "premiumYield": weekly_yield,
                    "passesMinPremium": passes_min,
                    "isBelowLowerBound": is_below,
                    "distanceBelowLowerBound": distance_below,
                    "status": status,
                    "reason": reason,
                }
            )

        below = [p for p in put_data if p["isBelowLowerBound"]]
        aggressive_pc = max(below, key=lambda p: p["strike"]) if below else None
        safe_pool = []
        if aggressive_pc is not None:
            safe_pool = [
                p for p in below
                if p["strike"] < aggressive_pc["strike"]
                and p["bid"] is not None
                and p["ask"] is not None
                and p["mid"] is not None
                and p["mid"] > 0
                and p["passesMinPremium"]
            ]
        safe_pc = None
        safe_reason = None
        if safe_pool:
            safe_pc = min(safe_pool, key=lambda p: p["strike"])
            safe_reason = "below_aggressive_meets_min_premium"
        elif aggressive_pc is not None and aggressive_pc.get("passesMinPremium"):
            safe_pc = aggressive_pc
            safe_reason = "aggressive_promoted_to_safe_no_lower_acceptable_strike"
        else:
            safe_reason = "no_safe_candidate_meets_min_premium" if aggressive_pc is not None else "no_put_below_lower_bound"

        safe_official_pc, safe_official_reason = _official_safe_from_pool(
            safe_pool=safe_pool,
            aggressive_pc=aggressive_pc,
            target_premium=target_premium,
        )

        option_quotes_received = 0
        for row in option_quote_samples:
            q = _leg_quotes(row["ticker"]) if row["kind"] == "expected_move" else _put_quotes(row["ticker"])
            if q["bid"] is not None or q["ask"] is not None or q["last"] is not None or q["close"] is not None:
                option_quotes_received += 1

        premium_used = None
        if safe_pc is not None:
            premium_used = safe_pc.get("primeUsed")
        elif aggressive_pc is not None:
            premium_used = aggressive_pc.get("primeUsed")
        premium_used_official = None
        if safe_official_pc is not None:
            premium_used_official = safe_official_pc.get("primeUsed")
        elif aggressive_pc is not None:
            premium_used_official = aggressive_pc.get("primeUsed")

        return {
            "ok": True,
            "reason": safe_reason,
            "symbol": symbol,
            "expiration": expiration_used,
            "spot": spot,
            "atmStrike": atm_strike,
            "expectedMove": expected_move,
            "lowerBound": lower_bound,
            "upperBound": upper_bound,
            "aggressiveStrike": aggressive_pc,
            "safeStrike": safe_pc,
            "safeStrikeLegacy": safe_pc,
            "safeStrikeOfficial": safe_official_pc,
            "safeReasonLegacy": safe_reason,
            "safeReasonOfficial": safe_official_reason,
            "targetPremium": target_premium,
            "premiumUsed": premium_used,
            "premiumUsedOfficial": premium_used_official,
            "optionQualifyCalls": metrics.option_qualify,
            "optionMarketDataRequests": metrics.option_mktdata,
            "totalApproxCalls": metrics.approx_calls(),
            "qualifiedContractsCount": len(qualified_option_keys),
            "optionQuotesReceivedCount": option_quotes_received,
            "expectedMoveContractsRequested": metrics.expected_move_contracts_requested,
            "putCandidateContractsRequested": metrics.put_contracts_requested,
            "putCandidatesCount": len(put_data),
            "putCandidates": put_data,
            "aggressiveReferenceStrike": aggressive_ref,
            "chosenPutStrikes": chosen_put_strikes,
            "safeSelectionOrder": [
                "1) below = puts isBelowLowerBound",
                "2) aggressive = max(strike) in below",
                "3) safe_pool = below with strike < aggressive, bid/ask/mid valides, passesMinPremium",
                "4) safe = min(strike) in safe_pool",
                "5) fallback: aggressive devient safe si passesMinPremium et safe_pool vide",
            ],
            "safeSelectionOrderOfficial": [
                "1) below = puts isBelowLowerBound",
                "2) aggressive = max(strike) in below",
                "3) safe_pool = below with strike < aggressive, bid/ask/mid valides, passesMinPremium",
                "4) safe officiel = min(abs(primeUsed-targetPremium), tie => strike le plus haut)",
                "5) fallback: aggressive devient safe si passesMinPremium et safe_pool vide",
            ],
            "rejectionReason": None if (aggressive_pc or safe_pc) else safe_reason,
        }
    except Exception as exc:
        return {"ok": False, "reason": f"exception:{type(exc).__name__}:{exc}"}
    finally:
        try:
            if ib.isConnected():
                ib.disconnect()
        except Exception:
            pass


def _pick_premium_used_from_old(payload: dict):
    safe = payload.get("safeStrike") if isinstance(payload, dict) else None
    agg = payload.get("aggressiveStrike") if isinstance(payload, dict) else None
    if isinstance(safe, dict):
        val = safe.get("primeUsed")
        if val is not None:
            return val
    if isinstance(agg, dict):
        return agg.get("primeUsed")
    return None


def _strike_of(obj):
    return obj.get("strike") if isinstance(obj, dict) else None


def _float_diff(a, b):
    try:
        if a is None or b is None:
            return None
        return float(a) - float(b)
    except Exception:
        return None


def _candidate_rows_from_old(old_payload: dict):
    rows = []
    candidates = old_payload.get("putCandidates") if isinstance(old_payload, dict) else None
    if not isinstance(candidates, list):
        return rows
    target = old_payload.get("targetPremium")
    safe_strike = _strike_of(old_payload.get("safeStrike"))
    for p in candidates:
        if not isinstance(p, dict):
            continue
        strike = p.get("strike")
        premium_used = p.get("primeUsed")
        distance_to_target = None
        if premium_used is not None and target is not None:
            try:
                distance_to_target = float(premium_used) - float(target)
            except Exception:
                distance_to_target = None
        rows.append(
            {
                "strike": strike,
                "bid": p.get("bid"),
                "ask": p.get("ask"),
                "mid": p.get("mid"),
                "premiumUsed": premium_used,
                "targetPremium": target,
                "weeklyYield": p.get("premiumYield"),
                "meetsTarget": bool(p.get("passesMinPremium")),
                "distanceToTarget": distance_to_target,
                "selectedSafeOld": (
                    safe_strike is not None
                    and strike is not None
                    and abs(float(strike) - float(safe_strike)) < 1e-9
                ),
                "selectedSafeNew": False,
                "status": p.get("status"),
                "reason": p.get("reason"),
            }
        )
    rows.sort(key=lambda r: (r.get("strike") is None, -(r.get("strike") or 0)))
    return rows


def _candidate_rows_from_new(new_payload: dict):
    rows = []
    candidates = new_payload.get("putCandidates") if isinstance(new_payload, dict) else None
    if not isinstance(candidates, list):
        return rows
    target = new_payload.get("targetPremium")
    safe_legacy_strike = _strike_of(new_payload.get("safeStrikeLegacy") or new_payload.get("safeStrike"))
    safe_official_strike = _strike_of(new_payload.get("safeStrikeOfficial"))
    for p in candidates:
        if not isinstance(p, dict):
            continue
        strike = p.get("strike")
        premium_used = p.get("primeUsed")
        distance_to_target = None
        if premium_used is not None and target is not None:
            try:
                distance_to_target = float(premium_used) - float(target)
            except Exception:
                distance_to_target = None
        rows.append(
            {
                "strike": strike,
                "bid": p.get("bid"),
                "ask": p.get("ask"),
                "mid": p.get("mid"),
                "premiumUsed": premium_used,
                "targetPremium": target,
                "weeklyYield": p.get("premiumYield"),
                "meetsTarget": bool(p.get("passesMinPremium")),
                "distanceToTarget": distance_to_target,
                "selectedSafeLegacy": (
                    safe_legacy_strike is not None
                    and strike is not None
                    and abs(float(strike) - float(safe_legacy_strike)) < 1e-9
                ),
                "selectedSafeOfficial": (
                    safe_official_strike is not None
                    and strike is not None
                    and abs(float(strike) - float(safe_official_strike)) < 1e-9
                ),
                "status": p.get("status"),
                "reason": p.get("reason"),
            }
        )
    rows.sort(key=lambda r: (r.get("strike") is None, -(r.get("strike") or 0)))
    return rows


def _official_safe_from_pool(safe_pool: list[dict], aggressive_pc: dict | None, target_premium: float):
    if safe_pool:
        best = min(
            safe_pool,
            key=lambda p: (
                abs(float(p.get("primeUsed")) - float(target_premium)),
                -float(p.get("strike") or 0),
            ),
        )
        return best, "closest_premium_to_target"
    if aggressive_pc is not None and aggressive_pc.get("passesMinPremium"):
        return aggressive_pc, "aggressive_promoted_to_safe_no_lower_acceptable_strike"
    return None, "no_safe_candidate_meets_min_premium" if aggressive_pc is not None else "no_put_below_lower_bound"


def _to_strike_set(rows: list[dict]):
    out = set()
    for r in rows or []:
        try:
            s = r.get("strike") if isinstance(r, dict) else None
            if s is None:
                continue
            out.add(float(s))
        except Exception:
            continue
    return out


def _compute_safe_official_from_rows(rows: list[dict], target_premium: float, aggressive_strike):
    below = [p for p in rows if p.get("isBelowLowerBound")]
    if aggressive_strike is None:
        return None
    safe_pool = [
        p for p in below
        if p.get("strike") is not None
        and float(p.get("strike")) < float(aggressive_strike)
        and p.get("bid") is not None
        and p.get("ask") is not None
        and p.get("mid") is not None
        and float(p.get("mid")) > 0
        and p.get("passesMinPremium")
    ]
    if safe_pool:
        return min(
            safe_pool,
            key=lambda p: (
                abs(float(p.get("primeUsed")) - float(target_premium)),
                -float(p.get("strike") or 0),
            ),
        )
    return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default="TQQQ")
    parser.add_argument("--expiration", default="20260508")
    parser.add_argument("--maxSafeWindow", type=int, default=10, choices=[10, 15, 20])
    parser.add_argument("--clientId", type=int, default=910)
    args = parser.parse_args()

    symbol = str(args.symbol or "").strip().upper() or "TQQQ"
    expiration = _normalize_expiration(args.expiration or "20260508")

    old = _run_method_a_via_subprocess(symbol=symbol, expiration=expiration, client_id=args.clientId)
    new_by_window = {}
    for idx, window in enumerate([10, 15, 20]):
        new_by_window[str(window)] = _run_method_b_two_phase(
            symbol=symbol,
            expiration=expiration,
            safe_window=window,
            client_id=args.clientId + 10 + idx,
        )

    new_default = new_by_window[str(args.maxSafeWindow)]

    old_expected = old.get("expectedMove")
    new_expected = new_default.get("expectedMove")
    old_lb = old.get("lowerBound")
    new_lb = new_default.get("lowerBound")
    old_aggr = _strike_of(old.get("aggressiveStrike"))
    new_aggr = _strike_of(new_default.get("aggressiveStrike"))
    old_safe = _strike_of(old.get("safeStrike"))
    new_safe = _strike_of(new_default.get("safeStrikeLegacy") or new_default.get("safeStrike"))
    new_safe_official = _strike_of(new_default.get("safeStrikeOfficial"))

    expected_diff = _float_diff(old_expected, new_expected)
    lower_diff = _float_diff(old_lb, new_lb)
    pass_expected = expected_diff is not None and abs(expected_diff) <= 0.05
    pass_aggressive = (old_aggr is not None and new_aggr is not None and abs(float(old_aggr) - float(new_aggr)) < 1e-9)
    safe_explained = (
        old_safe == new_safe
        or (new_default.get("reason") in ("no_safe_candidate_meets_min_premium", "invalid_bid", "invalid_ask", "invalid_mid"))
    )
    pass_safe = bool(safe_explained)
    fail_no_puts = bool(old_aggr is not None and new_default.get("putCandidateContractsRequested", 0) == 0)

    def build_official_row(payload: dict):
        legacy = payload.get("safeStrikeLegacy") or payload.get("safeStrike")
        official = payload.get("safeStrikeOfficial")
        legacy_strike = _strike_of(legacy)
        official_strike = _strike_of(official)
        official_premium = official.get("primeUsed") if isinstance(official, dict) else None
        official_yield = official.get("premiumYield") if isinstance(official, dict) else None
        target = payload.get("targetPremium")
        official_distance = _float_diff(official_premium, target)
        changed = (
            legacy_strike is not None
            and official_strike is not None
            and abs(float(legacy_strike) - float(official_strike)) >= 1e-9
        )
        return {
            "safeLegacyMinStrike": legacy_strike,
            "safeOfficialClosestPremium": official_premium,
            "safeOfficialStrike": official_strike,
            "safeOfficialPremiumUsed": official_premium,
            "safeOfficialDistanceToTarget": official_distance,
            "safeOfficialWeeklyYield": official_yield,
            "changedVsLegacy": bool(changed),
            "reason": payload.get("safeReasonOfficial") or payload.get("reason"),
        }

    old_rows = old.get("putCandidates") if isinstance(old, dict) else []
    old_pool = sorted(_to_strike_set(old_rows), reverse=True)
    new_rows_by_window = {
        k: (v.get("putCandidates") if isinstance(v, dict) else []) or []
        for k, v in new_by_window.items()
    }
    new_pool_by_window = {
        k: sorted(_to_strike_set(rows), reverse=True)
        for k, rows in new_rows_by_window.items()
    }

    def _pool_stats(values):
        if not values:
            return {"min": None, "max": None}
        return {"min": min(values), "max": max(values)}

    intersection_by_window = {
        k: sorted(set(old_pool).intersection(set(v)), reverse=True)
        for k, v in new_pool_by_window.items()
    }
    only_in_old_by_window = {
        k: sorted(set(old_pool).difference(set(v)), reverse=True)
        for k, v in new_pool_by_window.items()
    }
    only_in_new_by_window = {
        k: sorted(set(v).difference(set(old_pool)), reverse=True)
        for k, v in new_pool_by_window.items()
    }

    new_default_rows = new_rows_by_window[str(args.maxSafeWindow)]
    intersect_default = set(intersection_by_window[str(args.maxSafeWindow)])
    rows_new_on_old_pool = [
        r for r in new_default_rows
        if r.get("strike") is not None and float(r.get("strike")) in intersect_default
    ]
    safe_new_using_old_pool = _compute_safe_official_from_rows(
        rows=rows_new_on_old_pool,
        target_premium=float(new_default.get("targetPremium") or 0),
        aggressive_strike=_strike_of(new_default.get("aggressiveStrike")),
    )
    safe_new_using_old_pool_strike = _strike_of(safe_new_using_old_pool)
    premium_new_using_old_pool = (
        safe_new_using_old_pool.get("primeUsed")
        if isinstance(safe_new_using_old_pool, dict)
        else None
    )
    distance_new_using_old_pool = _float_diff(
        premium_new_using_old_pool,
        new_default.get("targetPremium"),
    )

    comparison = {
        "symbol": symbol,
        "expiration": expiration,
        "spot": {
            "ancien": old.get("underlyingPrice"),
            "nouveau": new_default.get("spot"),
        },
        "atmStrike": {
            "ancien": old.get("expectedMoveComponents", {}).get("atmStraddle", {}).get("strike"),
            "nouveau": new_default.get("atmStrike"),
        },
        "expectedMove": {
            "ancien": old_expected,
            "nouveau": new_expected,
            "difference": expected_diff,
        },
        "lowerBound": {
            "ancien": old_lb,
            "nouveau": new_lb,
            "difference": lower_diff,
        },
        "aggressiveStrike": {"ancien": old_aggr, "nouveau": new_aggr},
        "safeStrike": {"ancien": old_safe, "nouveau": new_safe},
        "safeStrikeOfficial": {"nouveau": new_safe_official},
        "targetPremium": {
            "ancien": old.get("targetPremium"),
            "nouveau": new_default.get("targetPremium"),
        },
        "premiumUsed": {
            "ancien": _pick_premium_used_from_old(old),
            "nouveau": new_default.get("premiumUsed"),
        },
        "optionQualifyCalls": {
            "ancien": old.get("ibkrCallMetrics", {}).get("optionQualifyCalls"),
            "nouveau": new_default.get("optionQualifyCalls"),
        },
        "optionMarketDataRequests": {
            "ancien": old.get("ibkrCallMetrics", {}).get("optionMarketDataRequests"),
            "nouveau": new_default.get("optionMarketDataRequests"),
        },
        "totalApproxCalls": {
            "ancien": old.get("ibkrCallMetrics", {}).get("approxIbkrCalls"),
            "nouveau": new_default.get("totalApproxCalls"),
        },
        "qualifiedContractsCount": {
            "ancien": (
                (old.get("strikeValidation", {}).get("validCallStrikesCount") or 0)
                + (old.get("strikeValidation", {}).get("validPutStrikesCount") or 0)
            ),
            "nouveau": new_default.get("qualifiedContractsCount"),
        },
        "optionQuotesReceivedCount": {
            "ancien": (
                len(old.get("expectedMoveOptions") or [])
                + len(old.get("putCandidates") or [])
            ),
            "nouveau": new_default.get("optionQuotesReceivedCount"),
        },
        "EMContractsRequestedNouveau": new_default.get("expectedMoveContractsRequested"),
        "PUTContractsRequestedNouveau": {
            "10": new_by_window["10"].get("putCandidateContractsRequested"),
            "15": new_by_window["15"].get("putCandidateContractsRequested"),
            "20": new_by_window["20"].get("putCandidateContractsRequested"),
        },
        "reason": {"ancien": old.get("safeSelectionReason") or old.get("error"), "nouveau": new_default.get("reason")},
        "safeSelectionOrder": {
            "ancien": [
                "1) below = puts isBelowLowerBound",
                "2) aggressive = max(strike) in below",
                "3) safe_pool = below with strike < aggressive, bid/ask/mid valides, passesMinPremium",
                "4) safe = min(strike) in safe_pool",
                "5) fallback: aggressive devient safe si passesMinPremium et safe_pool vide",
            ],
            "nouveau": new_default.get("safeSelectionOrder"),
        },
        "putCandidatesDetail": {
            "ancien": _candidate_rows_from_old(old),
            "nouveau": _candidate_rows_from_new(new_default),
        },
        "putCandidatesSelectionContext": {
            "ancien": {
                "count": len(old.get("putCandidates") or []),
            },
            "nouveau": {
                "count": len(new_default.get("putCandidates") or []),
                "aggressiveReferenceStrike": new_default.get("aggressiveReferenceStrike"),
                "chosenPutStrikes": new_default.get("chosenPutStrikes"),
            },
        },
        "putCandidatePoolComparison": {
            "oldPoolStrikes": old_pool,
            "newPoolStrikesByWindow": new_pool_by_window,
            "intersectionByWindow": intersection_by_window,
            "onlyInOldByWindow": only_in_old_by_window,
            "onlyInNewByWindow": only_in_new_by_window,
            "oldPoolMinStrike": _pool_stats(old_pool)["min"],
            "oldPoolMaxStrike": _pool_stats(old_pool)["max"],
            "newPoolMinStrikeByWindow": {k: _pool_stats(v)["min"] for k, v in new_pool_by_window.items()},
            "newPoolMaxStrikeByWindow": {k: _pool_stats(v)["max"] for k, v in new_pool_by_window.items()},
        },
        "safeUsingOldEquivalentPool": {
            "safeNewUsingOldPool": safe_new_using_old_pool_strike,
            "premiumUsedNewUsingOldPool": premium_new_using_old_pool,
            "distanceToTargetNewUsingOldPool": distance_new_using_old_pool,
            "matchesOldSafeUsingOldPool": (
                old_safe is not None
                and safe_new_using_old_pool_strike is not None
                and abs(float(old_safe) - float(safe_new_using_old_pool_strike)) < 1e-9
            ),
        },
        "officialSafeRuleComparison": {
            "10": build_official_row(new_by_window["10"]),
            "15": build_official_row(new_by_window["15"]),
            "20": build_official_row(new_by_window["20"]),
        },
        "safeSummary": {
            "oldScannerSafe": old_safe,
            "newLegacySafe": new_safe,
            "newOfficialSafe": new_safe_official,
            "officialMatchesOld": (
                old_safe is not None
                and new_safe_official is not None
                and abs(float(old_safe) - float(new_safe_official)) < 1e-9
            ),
            "officialMatchesLegacy": (
                new_safe is not None
                and new_safe_official is not None
                and abs(float(new_safe) - float(new_safe_official)) < 1e-9
            ),
            "officialBetterByDistance": (
                build_official_row(new_default).get("safeOfficialDistanceToTarget") is not None
                and (
                    abs(float(build_official_row(new_default).get("safeOfficialDistanceToTarget")))
                    <= abs(float(_float_diff(new_default.get("premiumUsed"), new_default.get("targetPremium")) or 0))
                )
            ),
        },
        "criteria": {
            "PASS_expectedMove_diff_le_0_05": pass_expected,
            "PASS_same_aggressive_strike": pass_aggressive,
            "PASS_safe_identique_ou_explique": pass_safe,
            "FAIL_no_put_candidates_while_old_has_aggressive": fail_no_puts,
            "FAIL_changed_safe_or_aggressive_without_explanation": not pass_safe and not pass_aggressive,
            "PASS_official_safe_meets_target": (
                new_default.get("safeStrikeOfficial", {}).get("passesMinPremium")
                if isinstance(new_default.get("safeStrikeOfficial"), dict)
                else False
            ),
            "PASS_official_safe_closest_to_target": (
                (new_default.get("safeReasonOfficial") == "closest_premium_to_target")
                or (
                    new_default.get("safeReasonOfficial")
                    == "aggressive_promoted_to_safe_no_lower_acceptable_strike"
                )
            ),
            "WARN_official_safe_differs_from_old": (
                old_safe is not None
                and new_safe_official is not None
                and abs(float(old_safe) - float(new_safe_official)) >= 1e-9
            ),
            "WARN_legacy_safe_uses_min_strike_not_closest_premium": (
                new_safe is not None
                and new_safe_official is not None
                and abs(float(new_safe) - float(new_safe_official)) >= 1e-9
            ),
        },
        "oldPayloadCompact": {
            "ok": old.get("ok"),
            "error": old.get("error"),
            "safeSelectionReason": old.get("safeSelectionReason"),
        },
        "newByWindowCompact": {
            k: {
                "ok": v.get("ok"),
                "reason": v.get("reason"),
                "aggressive": _strike_of(v.get("aggressiveStrike")),
                "safe": _strike_of(v.get("safeStrike")),
                "qualify": v.get("optionQualifyCalls"),
                "mktData": v.get("optionMarketDataRequests"),
            }
            for k, v in new_by_window.items()
        },
    }

    print(json.dumps(comparison, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

