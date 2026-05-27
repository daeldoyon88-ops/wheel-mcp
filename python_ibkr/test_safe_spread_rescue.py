"""Tests unitaires — rescue SAFE spread local."""

import unittest

from safe_spread_rescue import (
    TWO_PHASE_PUT_WINDOW,
    SAFE_SPREAD_RESCUE_STRIKES_ABOVE,
    SAFE_SPREAD_RESCUE_STRIKES_BELOW,
    build_safe_rescue_strike_window,
    attempt_safe_spread_rescue,
    normalize_spread_pct_percent,
)


class SafeSpreadRescueTests(unittest.TestCase):
    def test_window_constants(self):
        self.assertEqual(TWO_PHASE_PUT_WINDOW, 10)
        self.assertEqual(SAFE_SPREAD_RESCUE_STRIKES_ABOVE, 2)
        self.assertEqual(SAFE_SPREAD_RESCUE_STRIKES_BELOW, 4)

    def test_build_rescue_window(self):
        ladder = [35.0, 36.0, 37.0, 37.5, 38.0, 38.5, 39.0, 39.5, 40.0]
        window = build_safe_rescue_strike_window(38.0, ladder)
        self.assertEqual(window, [35.0, 36.0, 37.0, 37.5, 38.5, 39.0])

    def test_apld_like_rescue(self):
        put_data = [
            {"strike": 39.0, "bid": 0.45, "ask": 0.5, "spreadPct": 0.117, "primeUsed": 0.45, "isBelowLowerBound": True},
            {"strike": 38.5, "bid": 0.31, "ask": 0.46, "spreadPct": 0.39, "primeUsed": 0.31, "isBelowLowerBound": True},
            {"strike": 38.0, "bid": 0.27, "ask": 0.67, "spreadPct": 0.851, "primeUsed": 0.27, "isBelowLowerBound": True},
            {"strike": 37.5, "bid": 0.24, "ask": 0.35, "spreadPct": 0.377, "primeUsed": 0.24, "isBelowLowerBound": True},
        ]
        safe_pc = put_data[2]
        rescued, diag = attempt_safe_spread_rescue(
            safe_pc=safe_pc,
            aggressive_pc={"strike": 39.0},
            put_data=put_data,
            strikes=[p["strike"] for p in put_data],
            lower_bound=39.2,
            target_premium=0.19,
            spot=41.0,
        )
        self.assertTrue(diag["safeSpreadRescueTriggered"])
        self.assertNotEqual(rescued["strike"], 38.0)
        self.assertIn(rescued["strike"], (37.5, 38.5))
        self.assertLess(normalize_spread_pct_percent(rescued["spreadPct"]), 85.0)

    def test_no_rescue_keeps_original(self):
        put_data = [
            {"strike": 38.0, "bid": 0.27, "ask": 0.67, "spreadPct": 0.851, "primeUsed": 0.27, "isBelowLowerBound": True},
            {"strike": 37.5, "bid": 0.1, "ask": 0.3, "spreadPct": 1.0, "primeUsed": 0.1, "isBelowLowerBound": True},
        ]
        rescued, diag = attempt_safe_spread_rescue(
            safe_pc=put_data[0],
            aggressive_pc={"strike": 39.0},
            put_data=put_data,
            strikes=[38.0, 37.5],
            lower_bound=39.0,
            target_premium=0.2,
            spot=41.0,
        )
        self.assertEqual(rescued["strike"], 38.0)
        self.assertEqual(diag["safeRescueReason"], "no_acceptable_rescue_candidate")


if __name__ == "__main__":
    unittest.main()
