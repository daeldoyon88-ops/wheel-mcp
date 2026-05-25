import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  resolveIbkrStrikeWindowDebugEnabled,
  resolveIbkrTwoPhaseScanEnabled,
  strikeVsLowerBound,
} from "./ibkr.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function runPythonSnippet(code) {
  return spawnSync("python", ["-c", code], {
    cwd: path.join(repoRoot, "python_ibkr"),
    encoding: "utf8",
    env: process.env,
  });
}

test("resolveIbkrStrikeWindowDebugEnabled: silencieux par défaut", () => {
  assert.equal(resolveIbkrStrikeWindowDebugEnabled(undefined), false);
  assert.equal(resolveIbkrStrikeWindowDebugEnabled(""), false);
  assert.equal(resolveIbkrStrikeWindowDebugEnabled("0"), false);
  assert.equal(resolveIbkrStrikeWindowDebugEnabled("false"), false);
});

test("resolveIbkrStrikeWindowDebugEnabled: activé avec IBKR_STRIKE_WINDOW_DEBUG=1", () => {
  assert.equal(resolveIbkrStrikeWindowDebugEnabled("1"), true);
  assert.equal(resolveIbkrStrikeWindowDebugEnabled("true"), true);
});

test("resolveIbkrTwoPhaseScanEnabled: TWO_PHASE reste le défaut", () => {
  assert.equal(resolveIbkrTwoPhaseScanEnabled(undefined), true);
  assert.equal(resolveIbkrTwoPhaseScanEnabled("0"), false);
});

test("strikeVsLowerBound: below / equal_or_above / unknown", () => {
  assert.deepEqual(strikeVsLowerBound(109, 110), {
    relation: "below",
    distancePct: -0.91,
  });
  assert.deepEqual(strikeVsLowerBound(110, 110), {
    relation: "equal_or_above",
    distancePct: 0,
  });
  assert.deepEqual(strikeVsLowerBound(111, 110), {
    relation: "equal_or_above",
    distancePct: 0.91,
  });
  assert.deepEqual(strikeVsLowerBound(null, 110), {
    relation: "unknown",
    distancePct: null,
  });
});

test("Python strike window debug: silencieux si variable absente ou 0", () => {
  const snippet = `
import io
import sys
from ibkr_strike_window_debug import log_strike_window_debug

for env_value in (None, "0"):
    buf = io.StringIO()
    old = sys.stderr
    sys.stderr = buf
    try:
        log_strike_window_debug(
            ticker="INTC",
            expiration="20260529",
            spot=119.84,
            expected_move=9.48,
            lower_bound=110.36,
            upper_bound=129.32,
            two_phase_enabled=True,
            two_phase_put_window=10,
            strikes=[110, 109, 108],
            chosen_put_strikes=[110, 109, 108],
            aggressive_reference_strike=110,
            safe_strike=109,
            aggressive_strike=110,
            enabled=(env_value == "1"),
        )
    finally:
        sys.stderr = old
    assert buf.getvalue() == "", repr(buf.getvalue())
print("ok")
`;
  const result = runPythonSnippet(snippet);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("Python strike window debug: log détaillé si activé", () => {
  const snippet = `
import io
import sys
from ibkr_strike_window_debug import log_strike_window_debug

buf = io.StringIO()
old = sys.stderr
sys.stderr = buf
try:
    log_strike_window_debug(
        ticker="INTC",
        expiration="20260529",
        spot=119.84,
        expected_move=9.48,
        lower_bound=110.36,
        upper_bound=129.32,
        two_phase_enabled=True,
        two_phase_put_window=10,
        strikes=[110, 109, 108, 107],
        chosen_put_strikes=[110, 109, 108, 107, 106, 105, 104, 103, 102, 101],
        aggressive_reference_strike=110,
        safe_strike=109,
        aggressive_strike=110,
        enabled=True,
    )
finally:
    sys.stderr = old
text = buf.getvalue()
assert "[IBKR STRIKE WINDOW] INTC 2026-05-29" in text
assert "mode=TWO_PHASE window=10" in text
assert "chosenPutStrikes=[110,109,108,107,106,105,104,103,102,101]" in text
assert "safe=109 (below lowerBound" in text
assert "aggressive=110 (below lowerBound" in text
print("ok")
`;
  const result = runPythonSnippet(snippet);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("Python strikeVsLowerBound: below / equal_or_above / unknown", () => {
  const snippet = `
from ibkr_strike_window_debug import strike_vs_lower_bound
assert strike_vs_lower_bound(109, 110) == ("below", -0.91)
assert strike_vs_lower_bound(110, 110) == ("equal_or_above", 0.0)
assert strike_vs_lower_bound(None, 110) == ("unknown", None)
print("ok")
`;
  const result = runPythonSnippet(snippet);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});

test("Python strike window debug: mode NORMAL avertit spot vs lowerBound", () => {
  const snippet = `
import io
import sys
from ibkr_strike_window_debug import log_strike_window_debug

buf = io.StringIO()
old = sys.stderr
sys.stderr = buf
try:
    log_strike_window_debug(
        ticker="APLD",
        expiration="20260529",
        spot=45.0,
        expected_move=3.0,
        lower_bound=42.0,
        upper_bound=48.0,
        two_phase_enabled=False,
        two_phase_put_window=10,
        strikes=[44, 43, 42, 41, 40.5, 40],
        chosen_put_strikes=[44, 43, 42, 41, 40.5, 40],
        aggressive_reference_strike=None,
        safe_strike=41,
        aggressive_strike=41.5,
        enabled=True,
    )
finally:
    sys.stderr = old
text = buf.getvalue()
assert "mode=NORMAL" in text
assert "warning=NORMAL mode uses strikes under spot, not lowerBound" in text
print("ok")
`;
  const result = runPythonSnippet(snippet);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /ok/);
});
