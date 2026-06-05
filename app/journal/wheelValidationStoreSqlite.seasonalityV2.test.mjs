import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createWheelValidationStoreSqlite } from "./wheelValidationStoreSqlite.js";

// Patch Journal POP Snapshot V2 — migration idempotente + insertion des nouvelles
// colonnes décisionnelles, en restant rétro-compatible (NULL si absentes).

const V2_COLUMNS = [
  "seasonality_weekly_score_at_scan",
  "seasonality_weekly_win_rate_at_scan",
  "seasonality_annual_score_at_scan",
  "seasonality_annual_win_rate_at_scan",
  "seasonality_annual_window_label_at_scan",
  "seasonality_csp_score_at_scan",
  "seasonality_cc_score_at_scan",
  "seasonality_wheel_verdict_at_scan",
  "seasonality_context_at_scan",
];

function tmpPaths() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wvr-v2-"));
  return { sqlitePath: path.join(dir, "journal.sqlite"), jsonPath: path.join(dir, "absent.json") };
}

function readColumns(sqlitePath) {
  const conn = new DatabaseSync(sqlitePath);
  try {
    return new Set(
      conn.prepare("PRAGMA table_info(wheel_validation_records)").all().map((c) => c.name)
    );
  } finally {
    conn.close();
  }
}

// ── 1. Migration : les colonnes V2 existent ───────────────────────────────────
test("migration : les 9 colonnes V2 sont créées", async () => {
  const { sqlitePath, jsonPath } = tmpPaths();
  const store = createWheelValidationStoreSqlite({ sqlitePath, jsonPath });
  await store.load(); // déclenche ensureInitialized (migrations)
  const cols = readColumns(sqlitePath);
  for (const c of V2_COLUMNS) assert.ok(cols.has(c), `colonne V2 manquante : ${c}`);
  // L'ancienne colonne reste présente (non supprimée).
  assert.ok(cols.has("seasonality_score_at_scan"));
});

// ── 2. Migration idempotente : 2e init ne plante pas ──────────────────────────
test("migration : ré-initialiser une base déjà migrée ne plante pas", async () => {
  const { sqlitePath, jsonPath } = tmpPaths();
  await createWheelValidationStoreSqlite({ sqlitePath, jsonPath }).load();
  // 2e store sur la même base — les ALTER déjà appliqués sont ignorés (idempotent).
  await assert.doesNotReject(() =>
    createWheelValidationStoreSqlite({ sqlitePath, jsonPath }).load()
  );
  const cols = readColumns(sqlitePath);
  for (const c of V2_COLUMNS) assert.ok(cols.has(c));
});

// ── 3. Insertion : champs V2 persistés quand présents ─────────────────────────
test("insertion : les champs V2 sont écrits quand le snapshot les fournit", async () => {
  const { sqlitePath, jsonPath } = tmpPaths();
  const store = createWheelValidationStoreSqlite({ sqlitePath, jsonPath });
  const record = {
    id: "TQQQ_20260620_safe_50_2026-06-05",
    symbol: "TQQQ",
    seasonality: {
      seasonality_score_at_scan: 44,
      seasonality_win_rate_at_scan: 0.5,
      seasonality_snapshot_version: "decision-header-v1@2026-06-05",
      seasonality_weekly_score_at_scan: 44,
      seasonality_weekly_win_rate_at_scan: 0.5,
      seasonality_annual_score_at_scan: 87,
      seasonality_annual_win_rate_at_scan: 0.8,
      seasonality_annual_window_label_at_scan: "15 avr. → 15 juil.",
      seasonality_csp_score_at_scan: 56,
      seasonality_cc_score_at_scan: 39,
      seasonality_wheel_verdict_at_scan: "CSP acceptable avec prudence",
      seasonality_context_at_scan: "Fenêtre annuelle favorable, score court terme neutre.",
    },
  };
  await store.save({ records: [record] });

  const conn = new DatabaseSync(sqlitePath);
  try {
    const row = conn
      .prepare("SELECT * FROM wheel_validation_records WHERE id = @id")
      .get({ id: record.id });
    // Ancien champ inchangé.
    assert.equal(row.seasonality_score_at_scan, 44);
    // Nouveaux champs V2.
    assert.equal(row.seasonality_weekly_score_at_scan, 44);
    assert.equal(row.seasonality_annual_score_at_scan, 87);
    assert.equal(row.seasonality_annual_win_rate_at_scan, 0.8);
    assert.equal(row.seasonality_annual_window_label_at_scan, "15 avr. → 15 juil.");
    assert.equal(row.seasonality_csp_score_at_scan, 56);
    assert.equal(row.seasonality_cc_score_at_scan, 39);
    assert.equal(row.seasonality_wheel_verdict_at_scan, "CSP acceptable avec prudence");
    assert.match(row.seasonality_context_at_scan, /Fenêtre annuelle favorable/);
  } finally {
    conn.close();
  }
});

// ── 4. Insertion : NULL si V2 absents (record legacy) ─────────────────────────
test("insertion : un record legacy (sans champs V2) ⇒ colonnes V2 à NULL", async () => {
  const { sqlitePath, jsonPath } = tmpPaths();
  const store = createWheelValidationStoreSqlite({ sqlitePath, jsonPath });
  const legacyRecord = {
    id: "OLD_20260620_safe_50_2026-06-05",
    symbol: "OLD",
    seasonality: {
      seasonality_score_at_scan: 50,
      seasonality_direction: "neutre",
    },
  };
  await store.save({ records: [legacyRecord] });

  const conn = new DatabaseSync(sqlitePath);
  try {
    const row = conn
      .prepare("SELECT * FROM wheel_validation_records WHERE id = @id")
      .get({ id: legacyRecord.id });
    assert.equal(row.seasonality_score_at_scan, 50); // legacy conservé
    for (const c of V2_COLUMNS) assert.equal(row[c], null, `${c} devrait être NULL`);
  } finally {
    conn.close();
  }
});
