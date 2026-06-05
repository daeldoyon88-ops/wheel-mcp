import test from "node:test";
import assert from "node:assert/strict";
import { createWheelValidationService } from "./wheelValidationService.js";

const STUB_STORE = { load: async () => ({ version: "1.0", records: [] }) };

function makeCandidate(symbol = "TQQQ") {
  return {
    symbol,
    expiration: "20260620",
    safeStrike: { strike: 50, premium: 0.5, bid: 0.48, ask: 0.52 },
    aggressiveStrike: { strike: 55, premium: 0.7, bid: 0.68, ask: 0.72 },
  };
}

const VALID_SNAPSHOT = {
  seasonality_score_at_scan: 78,
  seasonality_win_rate_at_scan: 0.7,
  seasonality_best_window_start: "05-15",
  seasonality_best_window_end: "08-15",
  seasonality_direction: "favorable",
  seasonality_confidence: "mesurable",
  seasonality_snapshot_version: "decision-header-v1@2026-06-05",
};

// ── cache valide injecté → records.seasonality non null, dédup par symbole ─────
test("buildRecordsFromCandidates remplit seasonality depuis le cache (dédup symbole)", () => {
  const service = createWheelValidationService({ store: STUB_STORE });
  const calls = [];
  const records = service.buildRecordsFromCandidates([makeCandidate("TQQQ")], {
    scanTimestamp: "2026-06-05T12:00:00.000Z",
    resolveSeasonalitySnapshot: (sym) => {
      calls.push(sym);
      return VALID_SNAPSHOT;
    },
  });
  delete records._diagnostics;
  // safe + aggressive ⇒ 2 records, mais une seule lecture cache (dédup).
  assert.equal(records.length, 2);
  assert.equal(calls.length, 1, "résolveur appelé une seule fois pour safe+aggressive");
  assert.equal(calls[0], "TQQQ");
  for (const rec of records) {
    assert.equal(rec.seasonality.seasonality_score_at_scan, 78);
    assert.equal(rec.seasonality.seasonality_direction, "favorable");
    assert.equal(rec.seasonality.seasonality_best_window_start, "05-15");
  }
});

// ── cache absent → seasonality null, capture continue (records produits) ───────
test("buildRecordsFromCandidates : cache absent ⇒ seasonality null, records quand même", () => {
  const service = createWheelValidationService({ store: STUB_STORE });
  const records = service.buildRecordsFromCandidates([makeCandidate("XLF")], {
    scanTimestamp: "2026-06-05T12:00:00.000Z",
    resolveSeasonalitySnapshot: () => null, // cache absent
  });
  delete records._diagnostics;
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.equal(rec.seasonality.seasonality_score_at_scan, null);
    assert.equal(rec.seasonality.seasonality_win_rate_at_scan, null);
    assert.equal(rec.seasonality.seasonality_snapshot_version, null);
  }
});

// ── résolveur qui jette → snapshot null, aucune exception, capture continue ────
test("buildRecordsFromCandidates : un résolveur qui jette n'interrompt pas la capture", () => {
  const service = createWheelValidationService({ store: STUB_STORE });
  let records;
  assert.doesNotThrow(() => {
    records = service.buildRecordsFromCandidates([makeCandidate("BOOM")], {
      scanTimestamp: "2026-06-05T12:00:00.000Z",
      resolveSeasonalitySnapshot: () => {
        throw new Error("cache explosion");
      },
    });
  });
  delete records._diagnostics;
  assert.equal(records.length, 2);
  for (const rec of records) {
    assert.equal(rec.seasonality.seasonality_score_at_scan, null);
  }
});
