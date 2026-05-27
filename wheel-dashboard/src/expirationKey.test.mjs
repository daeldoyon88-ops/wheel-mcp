import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeExpirationKey,
  candidateRowMatchesSelectedExpiration,
  collectCandidateExpirationKeys,
} from "./expirationKey.js";

test("normalizeExpirationKey — formats usuels", () => {
  assert.equal(normalizeExpirationKey("20260605"), "2026-06-05");
  assert.equal(normalizeExpirationKey("2026-06-05"), "2026-06-05");
  assert.equal(normalizeExpirationKey(20260605), "2026-06-05");
  assert.equal(normalizeExpirationKey("2026-06-05T00:00:00.000Z"), "2026-06-05");
  assert.equal(normalizeExpirationKey(new Date(2026, 5, 5)), "2026-06-05");
});

test("normalizeExpirationKey — valeurs invalides", () => {
  assert.equal(normalizeExpirationKey(null), null);
  assert.equal(normalizeExpirationKey(""), null);
  assert.equal(normalizeExpirationKey("invalid"), null);
});

test("candidateRowMatchesSelectedExpiration — compact vs ISO sur targetExpiration", () => {
  const item = {
    ticker: "TQQQ",
    targetExpiration: "2026-06-05",
    expiration: "20260605",
    raw: { expiration: "2026-06-05" },
  };
  assert.equal(candidateRowMatchesSelectedExpiration(item, "2026-06-05"), true);
  assert.equal(candidateRowMatchesSelectedExpiration(item, "20260605"), true);
});

test("candidateRowMatchesSelectedExpiration — champ imbriqué périmé mais target OK", () => {
  const item = {
    ticker: "APLD",
    targetExpiration: "2026-06-05",
    expiration: "2026-06-05",
    yahoo: { targetExpiration: "2026-05-29" },
    ibkrDirect: { expiration: "20260605" },
  };
  assert.equal(candidateRowMatchesSelectedExpiration(item, "2026-06-05"), true);
});

test("candidateRowMatchesSelectedExpiration — rejette si aucune expiration ne correspond", () => {
  const item = {
    ticker: "SOXL",
    targetExpiration: "2026-05-29",
    expiration: "20260529",
    raw: { expiration: "2026-05-29" },
  };
  assert.equal(candidateRowMatchesSelectedExpiration(item, "2026-06-05"), false);
});

test("collectCandidateExpirationKeys — déduplique les formats équivalents", () => {
  const keys = collectCandidateExpirationKeys({
    targetExpiration: "2026-06-05",
    expiration: "20260605",
    ibkrDirect: { expiration: "20260605" },
  });
  assert.deepEqual(keys, ["2026-06-05"]);
});
