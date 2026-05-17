import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildPortfolioCombos,
  resolveCapitalComboTraceDebugEnabled,
} from "../../wheel-dashboard/src/capitalComboPortfolio.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FX = join(REPO_ROOT, "data/fixtures/minimal-capital-combo-replay.json");

test("resolveCapitalComboTraceDebugEnabled honore CAPITAL_COMBO_TRACE_DEBUG=1", () => {
  const prev = process.env.CAPITAL_COMBO_TRACE_DEBUG;
  try {
    process.env.CAPITAL_COMBO_TRACE_DEBUG = "1";
    assert.strictEqual(resolveCapitalComboTraceDebugEnabled({}), true);
    delete process.env.CAPITAL_COMBO_TRACE_DEBUG;
    assert.strictEqual(resolveCapitalComboTraceDebugEnabled({ capitalComboTraceDebug: true }), true);
    assert.strictEqual(resolveCapitalComboTraceDebugEnabled({}), false);
  } finally {
    if (prev === undefined) delete process.env.CAPITAL_COMBO_TRACE_DEBUG;
    else process.env.CAPITAL_COMBO_TRACE_DEBUG = prev;
  }
});

test("buildPortfolioCombos attache capitalComboAllocationTraceV1 quand trace activé explicitement", () => {
  const payload = JSON.parse(readFileSync(FX, "utf8"));
  const candidates = payload.comboReplayCandidates;
  assert.ok(Array.isArray(candidates) && candidates.length > 0);

  const ibkrRej = Array.isArray(payload.ibkrRejectedSymbolsSnapshot)
    ? new Set(payload.ibkrRejectedSymbolsSnapshot.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean))
    : new Set();

  const holder = {};
  buildPortfolioCombos(
    candidates,
    Number(payload.capital),
    Number(payload.maxCapitalPct),
    Number(payload.maxPositions),
    ibkrRej,
    { comboTracePayloadHolder: holder, capitalComboTraceDebug: true, capitalComboTraceSuppressConsoleLogs: true },
  );

  assert.ok(holder.capitalComboAllocationTraceV1 != null && typeof holder.capitalComboAllocationTraceV1 === "object");
  const tr = holder.capitalComboAllocationTraceV1;

  assert.strictEqual(tr.exportVersion, "capital-combo-allocation-trace-v1");
  assert.ok(Array.isArray(tr.shortlistSnapshot) && tr.shortlistSnapshot.length >= 1);

  assert.ok(typeof tr.allocationTrace === "object");
  ["AGGRESSIVE", "BALANCED", "SAFE"].forEach((k) => {
    assert.ok(tr.allocationTrace[k] != null, `allocationTrace.${k}`);
  });

  assert.ok(typeof tr.scoredCandidatesByMode === "object");

  assert.ok(typeof tr.nearMissFocus === "object");
  assert.strictEqual(typeof tr.nearMissFocus.OKLO, "object");
});
