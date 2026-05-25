import assert from "node:assert/strict";
import test from "node:test";

import {
  formatIbkrTwoPhaseScanLog,
  resolveIbkrTwoPhasePutWindow,
  resolveIbkrTwoPhaseScanEnabled,
} from "./ibkr.js";

test("resolveIbkrTwoPhaseScanEnabled: TWO_PHASE sans variable", () => {
  assert.equal(resolveIbkrTwoPhaseScanEnabled(undefined), true);
  assert.equal(resolveIbkrTwoPhaseScanEnabled(""), true);
});

test("resolveIbkrTwoPhaseScanEnabled: TWO_PHASE avec IBKR_TWO_PHASE_SCAN=1", () => {
  assert.equal(resolveIbkrTwoPhaseScanEnabled("1"), true);
});

test("resolveIbkrTwoPhaseScanEnabled: NORMAL avec IBKR_TWO_PHASE_SCAN=0", () => {
  assert.equal(resolveIbkrTwoPhaseScanEnabled("0"), false);
});

test("formatIbkrTwoPhaseScanLog: source default vs explicite", () => {
  const defaultCfg = formatIbkrTwoPhaseScanLog({});
  assert.equal(defaultCfg.mode, "TWO_PHASE");
  assert.match(defaultCfg.source, /default/);

  const explicitOn = formatIbkrTwoPhaseScanLog({ IBKR_TWO_PHASE_SCAN: "1" });
  assert.equal(explicitOn.mode, "TWO_PHASE");
  assert.match(explicitOn.source, /explicit/);

  const explicitOff = formatIbkrTwoPhaseScanLog({ IBKR_TWO_PHASE_SCAN: "0" });
  assert.equal(explicitOff.mode, "NORMAL");
  assert.match(explicitOff.source, /explicit off/);
});

test("resolveIbkrTwoPhasePutWindow: défaut 10", () => {
  assert.equal(resolveIbkrTwoPhasePutWindow(undefined), 10);
});
