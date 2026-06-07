import test from "node:test";
import assert from "node:assert/strict";

import { __testables__ } from "./wheelValidationService.js";

const { normalizeRecord, isOnePercentProfileRecord } = __testables__;

const SCAN_TS = "2026-05-29T14:00:00.000Z";

function buildCandidate({ expiration = "2026-06-05", strike = 100, premium = 1 } = {}) {
  return {
    symbol: "TQQQ",
    expiration,
    safeStrike: { strike, premium, bid: premium, ask: premium + 0.02, popEstimate: 0.92 },
    aggressiveStrike: { strike: strike + 2, premium: premium + 0.3, bid: premium + 0.3, ask: premium + 0.32, popEstimate: 0.88 },
  };
}

// ── Capture : alignement expiration ↔ selectedExpiration ────────────────────────

test("capture: options.selectedExpiration force expiration = selectedExpiration normalisée", () => {
  const candidate = buildCandidate({ expiration: "2026-06-05" });
  const record = normalizeRecord(candidate, "safe", SCAN_TS, "sess-1", {
    selectedExpiration: "2026-06-12",
  });
  assert.ok(record, "record doit être créé");
  assert.equal(record.expiration, "20260612", "expiration doit suivre selectedExpiration");
  assert.equal(record.selectedExpiration, "20260612", "selectedExpiration reste stocké");
  assert.equal(record.expiration, record.selectedExpiration, "aucune divergence à la capture");
});

test("capture: selectedExpiration absent garde le comportement fallback (candidate.expiration)", () => {
  const candidate = buildCandidate({ expiration: "2026-06-05" });
  const record = normalizeRecord(candidate, "safe", SCAN_TS, "sess-2", {});
  assert.ok(record, "record doit être créé");
  assert.equal(record.expiration, "20260605", "fallback sur candidate.expiration");
  // selectedExpiration retombe sur candidate.expiration via l'ancienne chaîne
  assert.equal(record.selectedExpiration, "20260605");
});

test("capture: selectedExpiration explicitement nul garde le fallback candidate.expiration", () => {
  const candidate = buildCandidate({ expiration: "2026-06-05" });
  const record = normalizeRecord(candidate, "safe", SCAN_TS, "sess-3", {
    selectedExpiration: null,
  });
  assert.ok(record);
  assert.equal(record.expiration, "20260605", "options.selectedExpiration nul ⇒ ancien comportement");
});

// ── Éligibilité profil : selectedExpiration ?? expiration ───────────────────────

test("isOnePercentProfileRecord: utilise selectedExpiration si présent", () => {
  const today = "2026-06-08";
  // Cohorte (expiration) déjà « expirée » avant aujourd'hui, mais contrat réel
  // (selectedExpiration) postérieur ⇒ ne doit PAS être éligible trop tôt.
  const record = {
    symbol: "TQQQ",
    strikeMode: "safe",
    captureClass: "primaryDaily",
    expiration: "20260605",
    selectedExpiration: "20260612",
    strike: { strike: 100 },
    resolution: { resolved: true },
  };
  assert.equal(
    isOnePercentProfileRecord(record, today),
    false,
    "record ne doit pas être éligible avant la vraie expiration (selectedExpiration)"
  );
});

test("isOnePercentProfileRecord: éligible une fois selectedExpiration dépassée", () => {
  const today = "2026-06-15";
  const record = {
    symbol: "TQQQ",
    strikeMode: "safe",
    captureClass: "primaryDaily",
    expiration: "20260605",
    selectedExpiration: "20260612",
    strike: { strike: 100 },
    resolution: { resolved: true },
  };
  assert.equal(isOnePercentProfileRecord(record, today), true);
});

test("isOnePercentProfileRecord: fallback sur expiration quand selectedExpiration absent", () => {
  const today = "2026-06-15";
  const record = {
    symbol: "TQQQ",
    strikeMode: "safe",
    captureClass: "primaryDaily",
    expiration: "20260605",
    strike: { strike: 100 },
    resolution: { resolved: true },
  };
  assert.equal(isOnePercentProfileRecord(record, today), true);
});

test("isOnePercentProfileRecord: cas mismatch historique, scan avant selectedExpiration non éligible", () => {
  // Reproduit le pattern J2 : expiration=20260605, selectedExpiration=20260612,
  // évaluation au 2026-06-07 (avant la vraie expiration) ⇒ non éligible.
  const today = "2026-06-07";
  const record = {
    symbol: "TQQQ",
    strikeMode: "safe",
    captureClass: "primaryDaily",
    expiration: "20260605",
    selectedExpiration: "20260612",
    strike: { strike: 100 },
    resolution: { resolved: true },
  };
  assert.equal(isOnePercentProfileRecord(record, today), false);
});
