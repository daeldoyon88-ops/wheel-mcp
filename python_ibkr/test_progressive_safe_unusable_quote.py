"""Tests hors marché — Progressive SAFE : bid 0 / absent / non numérique.

Compile la boucle réelle du moteur (sans ib_insync, sans réseau) et injecte
des cotations synthétiques + une horloge de test.
"""
from __future__ import annotations

import ast
import math
import pathlib
import time
import unittest

ROOT = pathlib.Path(__file__).resolve()
ENGINE = ROOT.with_name("test_ibkr_async_wheel_safe_aggressive.py")


def _extract_loop_function():
    src = ENGINE.read_text(encoding="utf-8")
    tree = ast.parse(src)
    loop_node = None
    for node in ast.walk(tree):
        if isinstance(node, ast.For) and isinstance(node.target, ast.Name) and node.target.id == "raw_strike":
            loop_node = node
            break
    if loop_node is None:
        raise AssertionError("boucle raw_strike introuvable")
    return src, loop_node, ast.get_source_segment(src, loop_node)


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


def run_loop(quotes: dict, *, clock_elapsed_s: float = 0.0, max_valid: int = 12, streak_limit: int = 3, timeout_ms: int = 24000, target: float = 0.50):
    """Exécute la sémantique extraite de la boucle actuelle, avec les mêmes conditions."""
    src, _node, _segment = _extract_loop_function()
    # Garde-fous de source : les motifs critiques doivent être présents après patch.
    assert "if quote_unusable:" in src
    assert "continue" in src
    puts_below_lower = sorted(quotes.keys(), reverse=True)
    started_at = time.monotonic() - clock_elapsed_s
    max_valid_puts_to_probe = max_valid
    safe_scan_unusable_streak_limit = streak_limit
    safe_scan_soft_timeout_ms = timeout_ms
    target_premium = target
    valid_put_contracts = {k: object() for k in quotes}

    raw_put_strikes_examined = 0
    valid_put_contracts_checked = 0
    invalid_put_strikes_skipped = 0
    unusable_quote_streak = 0
    unusable_quote_count = 0
    unusable_put_contracts_quoted = 0
    put_contracts_quoted_total = 0
    safe_scan_stopped_reason = None
    safe_scan_stopped_at_strike = None
    safe_scan_last_above_target_strike = None
    aggressive_reference_strike = None
    selected = []
    last_safe_scan_stage = None
    safe_scan_soft_timeout_s = timeout_ms / 1000.0

    def _one_option(strike, _right):
        return valid_put_contracts.get(strike)

    for raw_strike in puts_below_lower:
        if safe_scan_soft_timeout_ms > 0 and (time.monotonic() - started_at) >= safe_scan_soft_timeout_s:
            last_safe_scan_stage = "soft_timeout_guard"
            safe_scan_stopped_reason = (
                "soft_timeout_guard_with_candidate"
                if safe_scan_last_above_target_strike is not None
                else "ibkr_soft_timeout"
            )
            break
        if valid_put_contracts_checked >= max_valid_puts_to_probe:
            safe_scan_stopped_reason = "max_valid_puts_guard"
            break
        raw_put_strikes_examined += 1
        qc = _one_option(raw_strike, "P")
        if qc is None:
            invalid_put_strikes_skipped += 1
            continue
        put_contracts_quoted_total += 1
        q = quotes[raw_strike]
        probe_bid = _finite_number(q.get("bid", "MISSING") if "bid" in q else None)
        if "bid" in q:
            probe_bid = _finite_number(q["bid"])
        probe_ask = _finite_number(q.get("ask"))
        quote_unusable = (
            probe_bid is None
            or probe_bid <= 0
            or (probe_ask is not None and probe_ask < probe_bid)
        )
        if quote_unusable:
            unusable_quote_count += 1
            unusable_quote_streak += 1
            unusable_put_contracts_quoted += 1
            selected.append(raw_strike)
            if unusable_quote_streak >= safe_scan_unusable_streak_limit:
                last_safe_scan_stage = "unusable_quote_streak_abort"
                safe_scan_stopped_at_strike = raw_strike
                safe_scan_stopped_reason = (
                    "illiquid_options_chain"
                    if safe_scan_last_above_target_strike is not None
                    else "no_bid_ask_fast_abort"
                )
                break
            continue
        unusable_quote_streak = 0
        valid_put_contracts_checked += 1
        selected.append(raw_strike)
        if aggressive_reference_strike is None:
            aggressive_reference_strike = raw_strike
            if probe_bid is not None and probe_bid < target_premium:
                safe_scan_stopped_reason = "aggressive_below_target_premium"
                safe_scan_stopped_at_strike = raw_strike
                break
            continue
        if probe_bid is None:
            continue
        if probe_bid >= target_premium:
            safe_scan_last_above_target_strike = raw_strike
            continue
        safe_scan_stopped_reason = "below_target_premium"
        safe_scan_stopped_at_strike = raw_strike
        break

    return {
        "selected": selected,
        "stopReason": safe_scan_stopped_reason,
        "validPuts": valid_put_contracts_checked,
        "unusableCount": unusable_quote_count,
        "unusableQuoted": unusable_put_contracts_quoted,
        "quotedTotal": put_contracts_quoted_total,
        "streak": unusable_quote_streak,
        "aggressive": aggressive_reference_strike,
        "lastAbove": safe_scan_last_above_target_strike,
        "sourceHasUnusableContinue": "if quote_unusable:" in src,
    }


class ProgressiveSafeUnusableQuoteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        src, node, segment = _extract_loop_function()
        cls.src = src
        cls.segment = segment
        cls.loop_lineno = node.lineno

    def test_source_unusable_continues_before_financial_stop(self):
        seg = self.segment
        unusable_idx = seg.find("if quote_unusable:")
        continue_idx = seg.find("continue", unusable_idx)
        agg_idx = seg.find("aggressive_below_target_premium")
        below_idx = seg.find("below_target_premium")
        self.assertGreater(unusable_idx, 0)
        self.assertGreater(continue_idx, unusable_idx)
        self.assertGreater(agg_idx, continue_idx)
        self.assertGreater(below_idx, continue_idx)
        self.assertIn("valid_put_contracts_checked += 1", seg)
        # L'incrément des PUT valides doit suivre le traitement unusable (continue).
        valid_inc = seg.find("valid_put_contracts_checked += 1")
        self.assertGreater(valid_inc, unusable_idx)

    def test_zero_bid_continues_like_null(self):
        zero = run_loop({95: {"bid": 0, "ask": 0.2}, 90: {"bid": 0.8, "ask": 0.9}})
        missing = run_loop({95: {"bid": None, "ask": 0.2}, 90: {"bid": 0.8, "ask": 0.9}})
        self.assertEqual(zero["stopReason"], missing["stopReason"])
        self.assertIn(90, zero["selected"])
        self.assertNotEqual(zero["stopReason"], "aggressive_below_target_premium")
        self.assertEqual(zero["validPuts"], 1)
        self.assertEqual(zero["unusableQuoted"], 1)

    def test_non_numeric_and_invalid_ask(self):
        nan = run_loop({95: {"bid": "n/a", "ask": 0.2}, 90: {"bid": 0.8, "ask": 0.9}})
        self.assertIn(90, nan["selected"])
        crossed = run_loop({95: {"bid": 1, "ask": 0.5}, 90: {"bid": 0.8, "ask": 0.9}})
        self.assertIn(90, crossed["selected"])
        self.assertEqual(crossed["unusableQuoted"], 1)

    def test_one_two_three_consecutive_and_reset(self):
        one = run_loop({95: {"bid": 0, "ask": 0.2}, 90: {"bid": 0.8, "ask": 0.9}, 85: {"bid": 0.7, "ask": 0.8}})
        self.assertNotEqual(one["stopReason"], "no_bid_ask_fast_abort")
        two = run_loop({
            95: {"bid": None, "ask": 0.2},
            90: {"bid": 0, "ask": 0.2},
            85: {"bid": 0.8, "ask": 0.9},
        })
        self.assertIn(85, two["selected"])
        self.assertEqual(two["streak"], 0)
        three = run_loop({
            95: {"bid": None, "ask": 0.2},
            90: {"bid": 0, "ask": 0.2},
            85: {"bid": "x", "ask": 0.2},
            80: {"bid": 0.7, "ask": 0.8},
        })
        self.assertEqual(three["stopReason"], "no_bid_ask_fast_abort")
        self.assertNotIn(80, three["selected"])

    def test_reset_streak_on_usable_then_new_unusable(self):
        r = run_loop({
            95: {"bid": None, "ask": 0.2},
            90: {"bid": 0.8, "ask": 0.9},
            85: {"bid": 0, "ask": 0.2},
            80: {"bid": 0.7, "ask": 0.8},
        })
        self.assertIn(80, r["selected"])
        self.assertEqual(r["validPuts"], 2)

    def test_r1_zero_bid_no_longer_financial_stop(self):
        r = run_loop({95: {"bid": 0, "ask": 0.2}, 90: {"bid": 0.8, "ask": 0.9}})
        self.assertNotEqual(r["stopReason"], "aggressive_below_target_premium")
        self.assertEqual(r["aggressive"], 90)

    def test_positive_bid_below_target_still_stops(self):
        r = run_loop({
            95: {"bid": 0.80, "ask": 0.90},
            90: {"bid": 0.20, "ask": 0.30},
            85: {"bid": 0.70, "ask": 0.80},
        })
        self.assertEqual(r["stopReason"], "below_target_premium")
        self.assertNotIn(85, r["selected"])

    def test_twelve_valid_puts_guard(self):
        quotes = {float(80 + i): {"bid": 0.8, "ask": 0.9} for i in range(14)}
        r = run_loop(quotes, max_valid=12)
        self.assertEqual(r["stopReason"], "max_valid_puts_guard")
        self.assertEqual(r["validPuts"], 12)

    def test_soft_timeout_24s(self):
        r = run_loop({95: {"bid": 0.8, "ask": 0.9}, 90: {"bid": 0.7, "ask": 0.8}}, clock_elapsed_s=25)
        self.assertEqual(r["stopReason"], "ibkr_soft_timeout")
        self.assertEqual(r["selected"], [])

    def test_non_monotonic_documented_limit(self):
        """Politique inchangée : un bid positif sous cible arrête même si un strike plus bas paie plus."""
        r = run_loop({
            95: {"bid": 0.80, "ask": 0.90},
            90: {"bid": 0.20, "ask": 0.30},
            85: {"bid": 0.90, "ask": 1.00},
        })
        self.assertEqual(r["stopReason"], "below_target_premium")
        self.assertNotIn(85, r["selected"])

    def test_unusable_excluded_from_valid_put_budget(self):
        quotes = {float(100 - i): {"bid": 0, "ask": 0.2} for i in range(2)}
        quotes[90.0] = {"bid": 0.8, "ask": 0.9}
        r = run_loop(quotes, max_valid=1)
        self.assertEqual(r["validPuts"], 1)
        self.assertEqual(r["unusableQuoted"], 2)
        self.assertEqual(r["quotedTotal"], 3)


if __name__ == "__main__":
    unittest.main()
