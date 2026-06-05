/**
 * Journal POP — Backfill saisonnalité CACHE-ONLY (Phase 2A.1).
 *
 * Remplit les 7 colonnes seasonality_* des records historiques de
 * `wheel_validation_records` dont `seasonality_score_at_scan IS NULL`, en
 * lisant UNIQUEMENT le snapshot figé reconstruit depuis le cache persistant
 * `seasonality_cache` (via buildSeasonalitySnapshotFromCache).
 *
 * Garanties dures :
 *   - AUCUN appel Yahoo / réseau / fetch.
 *   - N'appelle JAMAIS computeSeasonalityBundle() ni /seasonality/warmup.
 *   - Ne calcule AUCUNE saisonnalité manquante (si pas dans le cache ⇒ skip).
 *   - N'écrase JAMAIS un record déjà rempli (WHERE seasonality_score_at_scan IS NULL).
 *   - Dry-run par défaut : aucune écriture tant que dryRun !== false.
 *   - Ne touche qu'aux 7 colonnes seasonality_* (aucune autre colonne modifiée).
 *
 * Le seul import « métier » est buildSeasonalitySnapshotFromCache, lui-même
 * cache-only (voir seasonalitySnapshot.js). node:sqlite/node:fs servent
 * exclusivement à lire/écrire la base Journal locale.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildSeasonalitySnapshotFromCache } from "./seasonalitySnapshot.js";

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

const SEASONALITY_COLUMNS = Object.freeze([
  "seasonality_score_at_scan",
  "seasonality_win_rate_at_scan",
  "seasonality_best_window_start",
  "seasonality_best_window_end",
  "seasonality_direction",
  "seasonality_confidence",
  "seasonality_snapshot_version",
]);

const SAMPLE_LIMIT = 25;

function normalizeSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function tableColumns(conn) {
  return new Set(
    conn
      .prepare("PRAGMA table_info(wheel_validation_records)")
      .all()
      .map((c) => c?.name)
      .filter(Boolean)
  );
}

/**
 * Liste les tickers candidats (seasonality_score_at_scan IS NULL), triés par
 * priorité : MAX(scanDate) DESC, puis SUM(ibkrValidated) DESC si la colonne
 * existe, puis COUNT(*) DESC.
 */
function findCandidateTickers(conn, { symbols = null, hasIbkrValidated = false } = {}) {
  const orderTerms = ["maxScanDate DESC"];
  if (hasIbkrValidated) orderTerms.push("ibkrSum DESC");
  orderTerms.push("cnt DESC", "symbol ASC");

  const ibkrSelect = hasIbkrValidated
    ? "SUM(COALESCE(ibkrValidated, 0)) AS ibkrSum"
    : "0 AS ibkrSum";

  let where = "seasonality_score_at_scan IS NULL AND symbol IS NOT NULL AND TRIM(symbol) != ''";
  const params = {};
  if (Array.isArray(symbols) && symbols.length) {
    const placeholders = symbols.map((_, i) => `@sym${i}`);
    where += ` AND UPPER(TRIM(symbol)) IN (${placeholders.join(", ")})`;
    symbols.forEach((s, i) => {
      params[`sym${i}`] = normalizeSymbol(s);
    });
  }

  const sql = `
    SELECT symbol AS symbol,
           MAX(scanDate) AS maxScanDate,
           ${ibkrSelect},
           COUNT(*) AS cnt
    FROM wheel_validation_records
    WHERE ${where}
    GROUP BY symbol
    ORDER BY ${orderTerms.join(", ")}
  `;
  return conn.prepare(sql).all(params);
}

/**
 * Exécute le backfill saisonnalité cache-only sur le Journal POP.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true]  false ⇒ écrit réellement les UPDATE.
 * @param {number|null} [options.limit]     nombre max de tickers traités.
 * @param {string[]|null} [options.symbols] restreint à certains symboles.
 * @param {string} [options.sqlitePath]     chemin de la base Journal.
 * @param {object} [options.conn]           connexion node:sqlite injectée (tests).
 * @param {(symbol: string) => object|null} [options.buildSnapshot]
 *        résolveur snapshot cache-only (défaut: buildSeasonalitySnapshotFromCache).
 *        Surchargé uniquement par les tests ; reste cache-only.
 * @param {object} [options.cache]          cache injecté transmis au résolveur par défaut.
 * @param {object} [options.cacheOptions]   options du cache persistant.
 * @returns {object} résumé structuré du backfill.
 */
export function runJournalSeasonalityBackfill(options = {}) {
  const startedAt = Date.now();
  const dryRun = options.dryRun !== false; // dry-run par défaut
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.trunc(limitRaw) : null;
  const symbols = Array.isArray(options.symbols)
    ? options.symbols.map(normalizeSymbol).filter(Boolean)
    : null;

  const buildSnapshot =
    typeof options.buildSnapshot === "function"
      ? options.buildSnapshot
      : (symbol) =>
          buildSeasonalitySnapshotFromCache(symbol, {
            cache: options.cache,
            cacheOptions: options.cacheOptions,
          });

  const summary = {
    dryRun,
    cacheOnly: true,
    limit,
    tickersCandidates: 0,
    tickersProcessed: 0,
    tickersUpdated: 0,
    tickersSkipped: 0,
    recordsWouldUpdate: 0,
    recordsUpdated: 0,
    skippedByReason: {},
    sample: [],
    errors: [],
    durationMs: 0,
  };

  const bumpReason = (reason) => {
    summary.skippedByReason[reason] = (summary.skippedByReason[reason] ?? 0) + 1;
  };
  const pushSample = (entry) => {
    if (summary.sample.length < SAMPLE_LIMIT) summary.sample.push(entry);
  };

  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
  const injectedConn = options.conn ?? null;
  let conn = injectedConn;

  try {
    if (!conn) {
      if (!existsSync(sqlitePath)) {
        summary.errors.push({ scope: "open", message: `sqlite_not_found: ${sqlitePath}` });
        return summary;
      }
      conn = new DatabaseSync(sqlitePath);
    }

    const columns = tableColumns(conn);
    const missingCols = SEASONALITY_COLUMNS.filter((c) => !columns.has(c));
    if (missingCols.length) {
      summary.errors.push({ scope: "schema", message: `missing_columns: ${missingCols.join(",")}` });
      return summary;
    }
    const hasIbkrValidated = columns.has("ibkrValidated");

    const candidates = findCandidateTickers(conn, { symbols, hasIbkrValidated });
    summary.tickersCandidates = candidates.length;

    const selected = limit != null ? candidates.slice(0, limit) : candidates;

    const countNullStmt = conn.prepare(
      "SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE symbol = @symbol AND seasonality_score_at_scan IS NULL"
    );
    const updateStmt = conn.prepare(`
      UPDATE wheel_validation_records SET
        seasonality_score_at_scan = @seasonality_score_at_scan,
        seasonality_win_rate_at_scan = @seasonality_win_rate_at_scan,
        seasonality_best_window_start = @seasonality_best_window_start,
        seasonality_best_window_end = @seasonality_best_window_end,
        seasonality_direction = @seasonality_direction,
        seasonality_confidence = @seasonality_confidence,
        seasonality_snapshot_version = @seasonality_snapshot_version
      WHERE symbol = @symbol AND seasonality_score_at_scan IS NULL
    `);

    for (const candidate of selected) {
      const symbol = normalizeSymbol(candidate?.symbol);
      summary.tickersProcessed += 1;

      let snapshot = null;
      try {
        snapshot = buildSnapshot(symbol);
      } catch (error) {
        summary.tickersSkipped += 1;
        bumpReason("error");
        summary.errors.push({ scope: "snapshot", symbol, message: String(error?.message ?? error) });
        pushSample({ symbol, status: "skipped", reason: "error" });
        continue;
      }

      if (!snapshot) {
        summary.tickersSkipped += 1;
        bumpReason("no_cache_or_invalid");
        pushSample({ symbol, status: "skipped", reason: "no_cache_or_invalid" });
        continue;
      }

      const nullCount = Number(countNullStmt.get({ symbol })?.cnt ?? 0);
      if (nullCount === 0) {
        // Aucun record NULL restant (rien à remplir, ne jamais écraser le reste).
        summary.tickersSkipped += 1;
        bumpReason("no_null_records");
        pushSample({ symbol, status: "skipped", reason: "no_null_records" });
        continue;
      }

      if (dryRun) {
        summary.recordsWouldUpdate += nullCount;
        summary.tickersUpdated += 1;
        pushSample({
          symbol,
          status: "would_update",
          recordsWouldUpdate: nullCount,
          version: snapshot.seasonality_snapshot_version ?? null,
        });
        continue;
      }

      try {
        const result = updateStmt.run({
          symbol,
          seasonality_score_at_scan: snapshot.seasonality_score_at_scan ?? null,
          seasonality_win_rate_at_scan: snapshot.seasonality_win_rate_at_scan ?? null,
          seasonality_best_window_start: snapshot.seasonality_best_window_start ?? null,
          seasonality_best_window_end: snapshot.seasonality_best_window_end ?? null,
          seasonality_direction: snapshot.seasonality_direction ?? null,
          seasonality_confidence: snapshot.seasonality_confidence ?? null,
          seasonality_snapshot_version: snapshot.seasonality_snapshot_version ?? null,
        });
        const changes = Number(result?.changes ?? 0);
        summary.recordsUpdated += changes;
        if (changes > 0) summary.tickersUpdated += 1;
        else {
          summary.tickersSkipped += 1;
          bumpReason("no_null_records");
        }
        pushSample({
          symbol,
          status: changes > 0 ? "updated" : "skipped",
          recordsUpdated: changes,
          version: snapshot.seasonality_snapshot_version ?? null,
        });
      } catch (error) {
        summary.tickersSkipped += 1;
        bumpReason("error");
        summary.errors.push({ scope: "update", symbol, message: String(error?.message ?? error) });
        pushSample({ symbol, status: "skipped", reason: "error" });
      }
    }
  } catch (error) {
    summary.errors.push({ scope: "run", message: String(error?.message ?? error) });
  } finally {
    if (!injectedConn && conn) {
      try {
        conn.close?.();
      } catch (_) {
        // Best-effort close only.
      }
    }
    summary.durationMs = Date.now() - startedAt;
  }

  return summary;
}
