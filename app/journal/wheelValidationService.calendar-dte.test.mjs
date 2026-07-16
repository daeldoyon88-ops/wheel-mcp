import assert from "node:assert/strict";
import test from "node:test";

import { createWheelValidationService } from "./wheelValidationService.js";

function makeStore() {
  const journal = { version: "1.0", records: [] };
  return {
    load: async () => journal,
    save: async () => journal,
  };
}

function makeCandidate() {
  return {
    symbol: "AAPL",
    expiration: "20260724",
    safeStrike: { strike: 200, premium: 1.2, bid: 1.2, ask: 1.25 },
    aggressiveStrike: { strike: 205, premium: 1.5, bid: 1.5, ask: 1.55 },
  };
}

test("Journal POP: le fallback DTE utilise la date civile New York à 00:01 et 23:59", async () => {
  for (const scanTimestamp of [
    "2026-07-16T04:01:00.000Z",
    "2026-07-17T03:59:00.000Z",
  ]) {
    const service = createWheelValidationService({ store: makeStore() });
    const result = await service.captureFromCandidates([makeCandidate()], {
      scanTimestamp,
      scanSessionId: `calendar-dte-${scanTimestamp}`,
    });

    assert.equal(result.captured, 2);
    assert.ok(result.records.every((record) => record.dteAtScan === 8));
  }
});
