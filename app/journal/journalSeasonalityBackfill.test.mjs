import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runJournalSeasonalityBackfill } from "./journalSeasonalityBackfillService.js";

const VALID_SNAPSHOT = {
  seasonality_score_at_scan: 78,
  seasonality_win_rate_at_scan: 0.7,
  seasonality_best_window_start: "05-15",
  seasonality_best_window_end: "08-15",
  seasonality_direction: "favorable",
  seasonality_confidence: "mesurable",
  seasonality_snapshot_version: "decision-header-v1@2026-06-05",
};

// Crée une base in-memory minimale avec les colonnes utilisées par le backfill.
function makeDb(rows = []) {
  const conn = new DatabaseSync(":memory:");
  conn.exec(`
    CREATE TABLE wheel_validation_records (
      id TEXT PRIMARY KEY,
      symbol TEXT,
      strikeMode TEXT,
      scanDate TEXT,
      ibkrValidated INTEGER,
      seasonality_score_at_scan REAL,
      seasonality_win_rate_at_scan REAL,
      seasonality_best_window_start TEXT,
      seasonality_best_window_end TEXT,
      seasonality_direction TEXT,
      seasonality_confidence TEXT,
      seasonality_snapshot_version TEXT
    );
  `);
  const stmt = conn.prepare(`
    INSERT INTO wheel_validation_records
      (id, symbol, strikeMode, scanDate, ibkrValidated, seasonality_score_at_scan)
    VALUES (@id, @symbol, @strikeMode, @scanDate, @ibkrValidated, @seasonality_score_at_scan)
  `);
  for (const r of rows) {
    stmt.run({
      id: r.id,
      symbol: r.symbol,
      strikeMode: r.strikeMode ?? "safe",
      scanDate: r.scanDate ?? "2026-06-01",
      ibkrValidated: r.ibkrValidated ?? 1,
      seasonality_score_at_scan: r.seasonality_score_at_scan ?? null,
    });
  }
  return conn;
}

function readRow(conn, id) {
  return conn.prepare("SELECT * FROM wheel_validation_records WHERE id = @id").get({ id });
}

// ── 1. Cache valide → update safe + aggressive du même ticker ─────────────────
test("write : un cache valide remplit safe ET aggressive du même ticker", () => {
  const conn = makeDb([
    { id: "TQQQ_safe", symbol: "TQQQ", strikeMode: "safe" },
    { id: "TQQQ_aggr", symbol: "TQQQ", strikeMode: "aggressive" },
  ]);
  const summary = runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(summary.recordsUpdated, 2);
  assert.equal(summary.tickersUpdated, 1);
  for (const id of ["TQQQ_safe", "TQQQ_aggr"]) {
    const row = readRow(conn, id);
    assert.equal(row.seasonality_score_at_scan, 78);
    assert.equal(row.seasonality_direction, "favorable");
    assert.equal(row.seasonality_best_window_start, "05-15");
    assert.equal(row.seasonality_snapshot_version, "decision-header-v1@2026-06-05");
  }
});

// ── 2. Cache absent → 0 update, skip no_cache_or_invalid ──────────────────────
test("cache absent ⇒ 0 update + skip no_cache_or_invalid", () => {
  const conn = makeDb([{ id: "XLF_safe", symbol: "XLF" }]);
  const summary = runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    buildSnapshot: () => null,
  });
  assert.equal(summary.recordsUpdated, 0);
  assert.equal(summary.tickersUpdated, 0);
  assert.equal(summary.skippedByReason.no_cache_or_invalid, 1);
  assert.equal(readRow(conn, "XLF_safe").seasonality_score_at_scan, null);
});

// ── 3. dryRun=true → aucun changement DB ──────────────────────────────────────
test("dryRun=true n'écrit rien mais compte recordsWouldUpdate", () => {
  const conn = makeDb([
    { id: "TQQQ_safe", symbol: "TQQQ" },
    { id: "TQQQ_aggr", symbol: "TQQQ" },
  ]);
  const summary = runJournalSeasonalityBackfill({
    dryRun: true,
    conn,
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.recordsWouldUpdate, 2);
  assert.equal(summary.recordsUpdated, 0);
  // DB intacte.
  assert.equal(readRow(conn, "TQQQ_safe").seasonality_score_at_scan, null);
  assert.equal(readRow(conn, "TQQQ_aggr").seasonality_score_at_scan, null);
});

// ── 4. Record déjà rempli → ne pas écraser ────────────────────────────────────
test("write : ne touche jamais un record déjà rempli (score non-null)", () => {
  const conn = makeDb([
    { id: "TQQQ_done", symbol: "TQQQ", seasonality_score_at_scan: 42 },
    { id: "TQQQ_null", symbol: "TQQQ", seasonality_score_at_scan: null },
  ]);
  const summary = runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(summary.recordsUpdated, 1);
  // Le record déjà rempli garde sa valeur d'origine.
  assert.equal(readRow(conn, "TQQQ_done").seasonality_score_at_scan, 42);
  assert.equal(readRow(conn, "TQQQ_done").seasonality_direction, null);
  // Le record NULL est rempli.
  assert.equal(readRow(conn, "TQQQ_null").seasonality_score_at_scan, 78);
});

// ── 5. symbols=TQQQ limite bien le traitement ─────────────────────────────────
test("symbols restreint le traitement aux symboles demandés", () => {
  const conn = makeDb([
    { id: "TQQQ_safe", symbol: "TQQQ" },
    { id: "SOFI_safe", symbol: "SOFI" },
  ]);
  const seen = [];
  const summary = runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    symbols: ["TQQQ"],
    buildSnapshot: (sym) => {
      seen.push(sym);
      return VALID_SNAPSHOT;
    },
  });
  assert.deepEqual(seen, ["TQQQ"]);
  assert.equal(summary.tickersCandidates, 1);
  assert.equal(readRow(conn, "TQQQ_safe").seasonality_score_at_scan, 78);
  assert.equal(readRow(conn, "SOFI_safe").seasonality_score_at_scan, null);
});

// ── 6. limit fonctionne ───────────────────────────────────────────────────────
test("limit borne le nombre de tickers traités", () => {
  const conn = makeDb([
    { id: "AAA_safe", symbol: "AAA", scanDate: "2026-06-03", ibkrValidated: 9 },
    { id: "BBB_safe", symbol: "BBB", scanDate: "2026-06-02", ibkrValidated: 5 },
    { id: "CCC_safe", symbol: "CCC", scanDate: "2026-06-01", ibkrValidated: 1 },
  ]);
  const seen = [];
  const summary = runJournalSeasonalityBackfill({
    dryRun: true,
    conn,
    limit: 2,
    buildSnapshot: (sym) => {
      seen.push(sym);
      return VALID_SNAPSHOT;
    },
  });
  assert.equal(summary.tickersCandidates, 3);
  assert.equal(summary.tickersProcessed, 2);
  // Priorité scanDate DESC ⇒ AAA puis BBB.
  assert.deepEqual(seen, ["AAA", "BBB"]);
});

// ── 7. Aucune référence Yahoo / fetch / computeSeasonalityBundle dans le service ─
test("le service ne référence aucun Yahoo / fetch / computeSeasonalityBundle", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "journalSeasonalityBackfillService.js"), "utf8");
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l));
  for (const line of importLines) {
    assert.doesNotMatch(line, /yahoo/i, `import Yahoo interdit: ${line}`);
    assert.doesNotMatch(line, /axios|undici|node-fetch|node:https?/, `client HTTP interdit: ${line}`);
  }
  // Code hors commentaires : aucun appel réseau / bundle live.
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /\bfetch\s*\(/, "aucun appel fetch(");
  assert.doesNotMatch(codeOnly, /computeSeasonalityBundle\s*\(/, "aucun computeSeasonalityBundle()");
  assert.doesNotMatch(codeOnly, /warmup/i, "aucune référence warmup");
});

// ── 8. Résumé : recordsWouldUpdate en dry-run, recordsUpdated en write ─────────
test("le résumé expose les bons compteurs selon le mode", () => {
  const rows = [{ id: "TQQQ_safe", symbol: "TQQQ" }];
  const dry = runJournalSeasonalityBackfill({
    dryRun: true,
    conn: makeDb(rows),
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(dry.cacheOnly, true);
  assert.equal(dry.recordsWouldUpdate, 1);
  assert.equal(dry.recordsUpdated, 0);
  assert.ok("skippedByReason" in dry && Array.isArray(dry.sample) && Array.isArray(dry.errors));
  assert.equal(typeof dry.durationMs, "number");

  const wet = runJournalSeasonalityBackfill({
    dryRun: false,
    conn: makeDb(rows),
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(wet.recordsUpdated, 1);
  assert.equal(wet.recordsWouldUpdate, 0);
});
