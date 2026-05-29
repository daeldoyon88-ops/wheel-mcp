import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import {
  createSeasonalityPersistentCache,
  SEASONALITY_CACHE_VERSION,
} from "./seasonalityPersistentCache.js";

function tmpDb() {
  const rand = Math.random().toString(36).slice(2);
  return path.join(os.tmpdir(), `seasonality_cache_test_${Date.now()}_${rand}.sqlite`);
}

const SAMPLE_PAYLOAD = {
  calendarData:  { months: [1, 2, 3] },
  shortTermData: { periods: [] },
  windowsData:   { windows: [] },
  chart3yData:   { ok: true, series: [] },
};

// ── 1. ensureInitialized crée la table ────────────────────────────────────────
test("ensureInitialized crée la table", async () => {
  const cache = createSeasonalityPersistentCache({ sqlitePath: tmpDb() });
  await cache.ensureInitialized();
  // Aucune donnée initialement — ne doit pas lever d'exception
  assert.equal(cache.getCache("TQQQ"), null);
});

// ── 2. setCache puis getCache retourne le payload ─────────────────────────────
test("setCache puis getCache retourne le payload", async () => {
  const cache = createSeasonalityPersistentCache({ sqlitePath: tmpDb() });
  await cache.ensureInitialized();
  cache.setCache("TQQQ", SAMPLE_PAYLOAD);
  const entry = cache.getCache("TQQQ");
  assert.ok(entry, "entry should exist");
  assert.deepEqual(entry.payload, SAMPLE_PAYLOAD);
  assert.equal(entry.ticker, "TQQQ");
  assert.equal(entry.cacheVersion, SEASONALITY_CACHE_VERSION);
});

// ── 3. isFresh true pour computed_at aujourd'hui ──────────────────────────────
test("isFresh true pour computed_at aujourd'hui", async () => {
  const cache = createSeasonalityPersistentCache({ sqlitePath: tmpDb() });
  await cache.ensureInitialized();
  cache.setCache("AAPL", SAMPLE_PAYLOAD);
  const entry = cache.getCache("AAPL");
  assert.ok(entry, "entry should exist");
  assert.equal(entry.fresh, true);
  assert.equal(cache.isFresh(entry), true);
});

// ── 4. isFresh false pour computed_at hier ────────────────────────────────────
test("isFresh false pour computed_at hier", async () => {
  const cache = createSeasonalityPersistentCache({ sqlitePath: tmpDb() });
  await cache.ensureInitialized();
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  cache.setCache("SOXL", SAMPLE_PAYLOAD, { computedAt: yesterday });
  const entry = cache.getCache("SOXL");
  assert.ok(entry, "entry should exist");
  assert.equal(entry.fresh, false);
  assert.equal(cache.isFresh(entry), false);
});

// ── 5. cleanOldVersions supprime les anciennes versions ───────────────────────
test("cleanOldVersions supprime les anciennes versions", async () => {
  const dbPath = tmpDb();

  // Instance V1 (active)
  const cacheNew = createSeasonalityPersistentCache({ sqlitePath: dbPath, cacheVersion: "v-new" });
  await cacheNew.ensureInitialized();
  cacheNew.setCache("NVDA", SAMPLE_PAYLOAD);

  // Instance V0 (ancienne — réutilise la même DB, table déjà créée)
  const cacheOld = createSeasonalityPersistentCache({ sqlitePath: dbPath, cacheVersion: "v-old" });
  cacheOld.setCache("NVDA", SAMPLE_PAYLOAD);

  // Vérification avant nettoyage
  assert.ok(cacheOld.getCache("NVDA"), "old entry should exist before clean");
  assert.ok(cacheNew.getCache("NVDA"), "new entry should exist before clean");

  // Nettoyage : supprime tout ce qui n'est pas "v-new"
  cacheNew.cleanOldVersions();

  assert.equal(cacheOld.getCache("NVDA"), null, "old version entry should be deleted");
  assert.ok(cacheNew.getCache("NVDA"), "new version entry should remain");
});

// ── 6. payload JSON corrompu retourne null sans crash ─────────────────────────
test("payload JSON corrompu retourne null et ne crash pas", async () => {
  const dbPath = tmpDb();
  const cache = createSeasonalityPersistentCache({ sqlitePath: dbPath });
  await cache.ensureInitialized();

  // Injecter une entrée corrompue directement en SQL
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT OR REPLACE INTO seasonality_cache
     (ticker, cache_version, payload_json, computed_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("AMD", SEASONALITY_CACHE_VERSION, "NOT_VALID_JSON{{{{", "2026-05-28", new Date().toISOString());

  // getCache doit retourner null et supprimer l'entrée corrompue
  const entry = cache.getCache("AMD");
  assert.equal(entry, null, "corrupt entry should return null");

  // Deuxième appel : l'entrée a été supprimée, toujours null
  const entry2 = cache.getCache("AMD");
  assert.equal(entry2, null, "second call after corrupt cleanup should be null");
});

// ── 7. bundle logiquement invalide — getCache supprime et retourne null ───────
test("bundle logiquement invalide supprimé par getCache", async () => {
  const dbPath = tmpDb();
  const cache = createSeasonalityPersistentCache({ sqlitePath: dbPath });
  await cache.ensureInitialized();

  const invalidJson = JSON.stringify({
    calendarData:  null,
    shortTermData: null,
    windowsData:   null,
    chart3yData:   { ok: false },
  });
  const db = new DatabaseSync(dbPath);
  db.prepare(
    `INSERT OR REPLACE INTO seasonality_cache
     (ticker, cache_version, payload_json, computed_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("TSLA", SEASONALITY_CACHE_VERSION, invalidJson, "2026-05-28", new Date().toISOString());

  assert.equal(cache.getCache("TSLA"), null, "invalid logical bundle should be purged");
  assert.equal(cache.getCache("TSLA"), null, "second call confirms deletion");
});

// ── 8. setCache refuse un bundle invalide ─────────────────────────────────────
test("setCache refuse un bundle invalide", async () => {
  const cache = createSeasonalityPersistentCache({ sqlitePath: tmpDb() });
  await cache.ensureInitialized();
  const invalid = {
    calendarData:  null,
    shortTermData: null,
    windowsData:   null,
    chart3yData:   { ok: false },
  };
  const written = cache.setCache("AMD", invalid);
  assert.equal(written, false);
  assert.equal(cache.getCache("AMD"), null);
});

// ── 9. clearCache et clearCaches ──────────────────────────────────────────────
test("clearCache et clearCaches suppriment les entrées", async () => {
  const cache = createSeasonalityPersistentCache({ sqlitePath: tmpDb() });
  await cache.ensureInitialized();
  cache.setCache("TSLA", SAMPLE_PAYLOAD);
  cache.setCache("AMD", SAMPLE_PAYLOAD);
  assert.ok(cache.getCache("TSLA"));
  assert.ok(cache.getCache("AMD"));

  assert.equal(cache.clearCache("TSLA"), true);
  assert.equal(cache.getCache("TSLA"), null);

  const cleared = cache.clearCaches(["AMD", "MISSING"]);
  assert.deepEqual(cleared, ["AMD"]);
  assert.equal(cache.getCache("AMD"), null);
});
