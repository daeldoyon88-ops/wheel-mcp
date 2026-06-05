import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  runJournalSeasonalityBackfill,
  MAX_FETCH_LIMIT,
  DEFAULT_FETCH_DELAY_MS,
} from "./journalSeasonalityBackfillService.js";

const VALID_SNAPSHOT = {
  seasonality_score_at_scan: 78,
  seasonality_win_rate_at_scan: 0.7,
  seasonality_best_window_start: "05-15",
  seasonality_best_window_end: "08-15",
  seasonality_direction: "favorable",
  seasonality_confidence: "mesurable",
  seasonality_snapshot_version: "decision-header-v1@2026-06-05",
};

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
test("write : un cache valide remplit safe ET aggressive du même ticker", async () => {
  const conn = makeDb([
    { id: "TQQQ_safe", symbol: "TQQQ", strikeMode: "safe" },
    { id: "TQQQ_aggr", symbol: "TQQQ", strikeMode: "aggressive" },
  ]);
  const summary = await runJournalSeasonalityBackfill({
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

// ── 2. Cache absent → 0 update, skip no_cache_or_invalid (sans fetch-missing) ─
test("cache absent ⇒ 0 update + skip no_cache_or_invalid", async () => {
  const conn = makeDb([{ id: "XLF_safe", symbol: "XLF" }]);
  const summary = await runJournalSeasonalityBackfill({
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
test("dryRun=true n'écrit rien mais compte recordsWouldUpdate", async () => {
  const conn = makeDb([
    { id: "TQQQ_safe", symbol: "TQQQ" },
    { id: "TQQQ_aggr", symbol: "TQQQ" },
  ]);
  const summary = await runJournalSeasonalityBackfill({
    dryRun: true,
    conn,
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(summary.dryRun, true);
  assert.equal(summary.recordsWouldUpdate, 2);
  assert.equal(summary.recordsUpdated, 0);
  assert.equal(readRow(conn, "TQQQ_safe").seasonality_score_at_scan, null);
  assert.equal(readRow(conn, "TQQQ_aggr").seasonality_score_at_scan, null);
});

// ── 4. Record déjà rempli → ne pas écraser ────────────────────────────────────
test("write : ne touche jamais un record déjà rempli (score non-null)", async () => {
  const conn = makeDb([
    { id: "TQQQ_done", symbol: "TQQQ", seasonality_score_at_scan: 42 },
    { id: "TQQQ_null", symbol: "TQQQ", seasonality_score_at_scan: null },
  ]);
  const summary = await runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(summary.recordsUpdated, 1);
  assert.equal(readRow(conn, "TQQQ_done").seasonality_score_at_scan, 42);
  assert.equal(readRow(conn, "TQQQ_done").seasonality_direction, null);
  assert.equal(readRow(conn, "TQQQ_null").seasonality_score_at_scan, 78);
});

// ── 5. symbols=TQQQ limite bien le traitement ─────────────────────────────────
test("symbols restreint le traitement aux symboles demandés", async () => {
  const conn = makeDb([
    { id: "TQQQ_safe", symbol: "TQQQ" },
    { id: "SOFI_safe", symbol: "SOFI" },
  ]);
  const seen = [];
  const summary = await runJournalSeasonalityBackfill({
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
test("limit borne le nombre de tickers traités", async () => {
  const conn = makeDb([
    { id: "AAA_safe", symbol: "AAA", scanDate: "2026-06-03", ibkrValidated: 9 },
    { id: "BBB_safe", symbol: "BBB", scanDate: "2026-06-02", ibkrValidated: 5 },
    { id: "CCC_safe", symbol: "CCC", scanDate: "2026-06-01", ibkrValidated: 1 },
  ]);
  const seen = [];
  const summary = await runJournalSeasonalityBackfill({
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
  assert.deepEqual(seen, ["AAA", "BBB"]);
});

// ── 7. Pas de client HTTP direct ni warmup dans le service ─────────────────────
test("le service n'embarque pas de client HTTP direct ni warmup/scan-summary", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "journalSeasonalityBackfillService.js"), "utf8");
  const importLines = src
    .split("\n")
    .filter((l) => /^\s*import\b/.test(l) || /\brequire\s*\(/.test(l));
  for (const line of importLines) {
    assert.doesNotMatch(line, /yahoo/i, `import Yahoo interdit: ${line}`);
    assert.doesNotMatch(line, /axios|undici|node-fetch|node:https?/, `client HTTP interdit: ${line}`);
  }
  const codeOnly = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "");
  assert.doesNotMatch(codeOnly, /\bfetch\s*\(/, "aucun appel fetch(");
  assert.doesNotMatch(codeOnly, /warmup/i, "aucune référence warmup");
  assert.doesNotMatch(codeOnly, /scan-summary|scanSummary/i, "aucune référence scan-summary");
  assert.match(codeOnly, /seasonalityBundleCompute/, "délègue au helper seasonalityBundleCompute");
});

// ── 8. Résumé : recordsWouldUpdate en dry-run, recordsUpdated en write ─────────
test("le résumé expose les bons compteurs selon le mode", async () => {
  const rows = [{ id: "TQQQ_safe", symbol: "TQQQ" }];
  const dry = await runJournalSeasonalityBackfill({
    dryRun: true,
    conn: makeDb(rows),
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(dry.cacheOnly, true);
  assert.equal(dry.recordsWouldUpdate, 1);
  assert.equal(dry.recordsUpdated, 0);
  assert.ok("skippedByReason" in dry && Array.isArray(dry.sample) && Array.isArray(dry.errors));
  assert.equal(typeof dry.durationMs, "number");

  const wet = await runJournalSeasonalityBackfill({
    dryRun: false,
    conn: makeDb(rows),
    buildSnapshot: () => VALID_SNAPSHOT,
  });
  assert.equal(wet.recordsUpdated, 1);
  assert.equal(wet.recordsWouldUpdate, 0);
});

// ── 9. fetch-missing dry-run : pas de fetch, would_fetch_and_update ────────────
test("fetch-missing dry-run : aucun fetch, would_fetch_and_update", async () => {
  const conn = makeDb([{ id: "NEW_safe", symbol: "NEW" }]);
  let fetchCalls = 0;
  const summary = await runJournalSeasonalityBackfill({
    dryRun: true,
    fetchMissing: true,
    conn,
    buildSnapshot: () => null,
    fetchBundle: async () => {
      fetchCalls += 1;
      return { ok: true, symbol: "NEW", persisted: true };
    },
  });
  assert.equal(fetchCalls, 0);
  assert.equal(summary.yahooEnabled, false);
  assert.equal(summary.tickersWouldFetch, 1);
  assert.equal(summary.recordsWouldUpdate, 1);
  assert.equal(summary.recordsUpdated, 0);
  assert.equal(summary.sample[0].status, "would_fetch_and_update");
  assert.equal(readRow(conn, "NEW_safe").seasonality_score_at_scan, null);
});

// ── 10. fetch-missing write : fetch une fois puis update ───────────────────────
test("fetch-missing write : appelle fetchBundle une fois puis met à jour", async () => {
  const conn = makeDb([{ id: "FETCH_safe", symbol: "FETCH" }]);
  let fetchCalls = 0;
  let snapshotReads = 0;
  const summary = await runJournalSeasonalityBackfill({
    dryRun: false,
    fetchMissing: true,
    delayMs: 0,
    conn,
    buildSnapshot: () => {
      snapshotReads += 1;
      return snapshotReads === 1 ? null : VALID_SNAPSHOT;
    },
    fetchBundle: async (sym) => {
      fetchCalls += 1;
      assert.equal(sym, "FETCH");
      return { ok: true, symbol: sym, persisted: true };
    },
  });
  assert.equal(fetchCalls, 1);
  assert.equal(summary.recordsUpdated, 1);
  assert.equal(readRow(conn, "FETCH_safe").seasonality_score_at_scan, 78);
});

// ── 11. fetch-missing write : échec fetch → skip fetch_failed_or_invalid ───────
test("fetch-missing write : échec fetch skip fetch_failed_or_invalid et continue", async () => {
  const conn = makeDb([
    { id: "BAD_safe", symbol: "BAD" },
    { id: "GOOD_safe", symbol: "GOOD" },
  ]);
  const summary = await runJournalSeasonalityBackfill({
    dryRun: false,
    fetchMissing: true,
    delayMs: 0,
    conn,
    buildSnapshot: (sym) => (sym === "GOOD" ? VALID_SNAPSHOT : null),
    fetchBundle: async (sym) => {
      if (sym === "BAD") return { ok: false, symbol: sym, error: "yahoo_down" };
      return { ok: true, symbol: sym, persisted: true };
    },
  });
  assert.equal(summary.skippedByReason.fetch_failed_or_invalid, 1);
  assert.equal(readRow(conn, "BAD_safe").seasonality_score_at_scan, null);
  assert.equal(readRow(conn, "GOOD_safe").seasonality_score_at_scan, 78);
});

// ── 12. délai configurable entre fetchs ───────────────────────────────────────
test("delayMs est respecté entre deux fetchs consécutifs", async () => {
  const conn = makeDb([
    { id: "A_safe", symbol: "AAA", scanDate: "2026-06-02" },
    { id: "B_safe", symbol: "BBB", scanDate: "2026-06-01" },
  ]);
  const fetchTimes = [];
  const readyAfterFetch = new Set();

  await runJournalSeasonalityBackfill({
    dryRun: false,
    fetchMissing: true,
    delayMs: 80,
    conn,
    buildSnapshot: (sym) => (readyAfterFetch.has(sym) ? VALID_SNAPSHOT : null),
    fetchBundle: async (sym) => {
      fetchTimes.push(Date.now());
      readyAfterFetch.add(sym);
      return { ok: true, symbol: sym, persisted: true };
    },
  });

  assert.equal(fetchTimes.length, 2);
  const gap = fetchTimes[1] - fetchTimes[0];
  assert.ok(gap >= 70, `écart ${gap}ms — attendu >= 70ms`);
  assert.equal(DEFAULT_FETCH_DELAY_MS, 3000);
  assert.equal(MAX_FETCH_LIMIT, 10);
});

// ── 13. CLI script : limit > 10 refusé quand fetch-missing ─────────────────────
test("script CLI refuse limit > 10 avec fetch-missing", async () => {
  const scriptPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/backfillJournalSeasonality.mjs"
  );
  const src = readFileSync(scriptPath, "utf8");
  assert.match(src, /MAX_FETCH_LIMIT/);
  assert.match(src, /DEFAULT_FETCH_MISSING_LIMIT\s*=\s*5/);
  assert.match(src, /--fetch-missing/);
});

// ── 14. Sans fetch-missing : cacheOnly inchangé ───────────────────────────────
test("sans fetch-missing : cacheOnly=true et yahooEnabled=false", async () => {
  const summary = await runJournalSeasonalityBackfill({
    dryRun: true,
    conn: makeDb([{ id: "T_safe", symbol: "T" }]),
    buildSnapshot: () => null,
  });
  assert.equal(summary.cacheOnly, true);
  assert.equal(summary.fetchMissing, false);
  assert.equal(summary.yahooEnabled, false);
});

// ── 15. Aucun appel warmup dans seasonalityBundleCompute ─────────────────────
test("seasonalityBundleCompute ne référence pas warmup ni scan-summary", () => {
  const computePath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../seasonality/seasonalityBundleCompute.js"
  );
  const src = readFileSync(computePath, "utf8");
  assert.doesNotMatch(src, /warmup/i);
  assert.doesNotMatch(src, /scan-summary|scanSummary|computeSeasonalityScanSummary/i);
});

// Snapshot partiel type OKLO : winRate/window/version présents mais score,
// direction et confidence null ⇒ entête décisionnel inexploitable.
const PARTIAL_SNAPSHOT_OKLO = {
  seasonality_score_at_scan: null,
  seasonality_win_rate_at_scan: 0.75,
  seasonality_best_window_start: "10-15",
  seasonality_best_window_end: "12-08",
  seasonality_direction: null,
  seasonality_confidence: null,
  seasonality_snapshot_version: "decision-header-v1@2026-06-05",
};

// ── 16. Snapshot partiel (cache-only) → skip incomplete_snapshot ──────────────
test("snapshot partiel cache-only ⇒ skip incomplete_snapshot, aucune écriture", async () => {
  const conn = makeDb([
    { id: "OKLO_safe", symbol: "OKLO", strikeMode: "safe" },
    { id: "OKLO_aggr", symbol: "OKLO", strikeMode: "aggressive" },
  ]);
  const summary = await runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    buildSnapshot: () => PARTIAL_SNAPSHOT_OKLO,
  });
  assert.equal(summary.skippedByReason.incomplete_snapshot, 1);
  assert.equal(summary.tickersUpdated, 0);
  assert.equal(summary.recordsUpdated, 0);
  // Aucun des 7 champs n'a été écrit.
  for (const id of ["OKLO_safe", "OKLO_aggr"]) {
    const row = readRow(conn, id);
    assert.equal(row.seasonality_score_at_scan, null);
    assert.equal(row.seasonality_win_rate_at_scan, null);
    assert.equal(row.seasonality_best_window_start, null);
    assert.equal(row.seasonality_direction, null);
    assert.equal(row.seasonality_confidence, null);
    assert.equal(row.seasonality_snapshot_version, null);
  }
});

// ── 17. Snapshot partiel en dry-run → recordsWouldUpdate non compté ───────────
test("snapshot partiel dry-run ⇒ recordsWouldUpdate = 0 et skip incomplete_snapshot", async () => {
  const conn = makeDb([{ id: "OKLO_safe", symbol: "OKLO" }]);
  const summary = await runJournalSeasonalityBackfill({
    dryRun: true,
    conn,
    buildSnapshot: () => PARTIAL_SNAPSHOT_OKLO,
  });
  assert.equal(summary.recordsWouldUpdate, 0);
  assert.equal(summary.tickersUpdated, 0);
  assert.equal(summary.skippedByReason.incomplete_snapshot, 1);
  assert.equal(readRow(conn, "OKLO_safe").seasonality_score_at_scan, null);
});

// ── 18. fetch-missing write : fetch produit un snapshot incomplet ─────────────
test("fetch-missing write : snapshot incomplet après fetch ⇒ skip fetch_incomplete_snapshot", async () => {
  const conn = makeDb([{ id: "OKLO_safe", symbol: "OKLO" }]);
  let snapshotReads = 0;
  const summary = await runJournalSeasonalityBackfill({
    dryRun: false,
    fetchMissing: true,
    delayMs: 0,
    conn,
    buildSnapshot: () => {
      snapshotReads += 1;
      // 1er read : pas de cache ⇒ déclenche le fetch ; 2e read : snapshot partiel.
      return snapshotReads === 1 ? null : PARTIAL_SNAPSHOT_OKLO;
    },
    fetchBundle: async (sym) => ({ ok: true, symbol: sym, persisted: true }),
  });
  assert.equal(summary.recordsUpdated, 0);
  assert.equal(summary.tickersUpdated, 0);
  assert.equal(summary.skippedByReason.fetch_incomplete_snapshot, 1);
  assert.equal(readRow(conn, "OKLO_safe").seasonality_score_at_scan, null);
});

// ── 18b. Patch V2 : remplit les colonnes V2 présentes sans écraser le legacy ──
const V2_SNAPSHOT = {
  ...VALID_SNAPSHOT,
  seasonality_weekly_score_at_scan: 44,
  seasonality_weekly_win_rate_at_scan: 0.5,
  seasonality_annual_score_at_scan: 87,
  seasonality_annual_win_rate_at_scan: 0.8,
  seasonality_annual_window_label_at_scan: "15 avr. → 15 juil.",
  seasonality_csp_score_at_scan: 56,
  seasonality_cc_score_at_scan: 39,
  seasonality_wheel_verdict_at_scan: "CSP acceptable avec prudence",
  seasonality_context_at_scan: "Fenêtre annuelle favorable, score court terme neutre.",
};

function makeDbV2(rows = []) {
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
      seasonality_snapshot_version TEXT,
      seasonality_weekly_score_at_scan REAL,
      seasonality_weekly_win_rate_at_scan REAL,
      seasonality_annual_score_at_scan REAL,
      seasonality_annual_win_rate_at_scan REAL,
      seasonality_annual_window_label_at_scan TEXT,
      seasonality_csp_score_at_scan REAL,
      seasonality_cc_score_at_scan REAL,
      seasonality_wheel_verdict_at_scan TEXT,
      seasonality_context_at_scan TEXT
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

test("write : colonnes V2 présentes ⇒ remplies dans le même UPDATE conservateur", async () => {
  const conn = makeDbV2([
    { id: "TQQQ_null", symbol: "TQQQ", seasonality_score_at_scan: null },
    { id: "TQQQ_done", symbol: "TQQQ", seasonality_score_at_scan: 42 },
  ]);
  const summary = await runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    buildSnapshot: () => V2_SNAPSHOT,
  });
  assert.equal(summary.recordsUpdated, 1);

  const filled = readRow(conn, "TQQQ_null");
  assert.equal(filled.seasonality_score_at_scan, 78);
  assert.equal(filled.seasonality_weekly_score_at_scan, 44);
  assert.equal(filled.seasonality_annual_score_at_scan, 87);
  assert.equal(filled.seasonality_annual_window_label_at_scan, "15 avr. → 15 juil.");
  assert.equal(filled.seasonality_csp_score_at_scan, 56);
  assert.equal(filled.seasonality_wheel_verdict_at_scan, "CSP acceptable avec prudence");

  // Record déjà rempli (score 42) → ni le legacy ni le V2 ne sont touchés.
  const done = readRow(conn, "TQQQ_done");
  assert.equal(done.seasonality_score_at_scan, 42);
  assert.equal(done.seasonality_weekly_score_at_scan, null);
  assert.equal(done.seasonality_annual_score_at_scan, null);
});

// ── 19. Champs vides (string "") traités comme incomplets ─────────────────────
test("direction/confidence vides ('') comptent comme incomplet", async () => {
  const conn = makeDb([{ id: "X_safe", symbol: "X" }]);
  const summary = await runJournalSeasonalityBackfill({
    dryRun: false,
    conn,
    buildSnapshot: () => ({
      ...VALID_SNAPSHOT,
      seasonality_direction: "",
      seasonality_confidence: "   ",
    }),
  });
  assert.equal(summary.recordsUpdated, 0);
  assert.equal(summary.skippedByReason.incomplete_snapshot, 1);
});
