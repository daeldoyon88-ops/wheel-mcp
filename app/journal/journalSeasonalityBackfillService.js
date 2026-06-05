/**
 * Journal POP — Backfill saisonnalité (Phase 2A.1 cache-only, Phase 2A.2 fetch-missing).
 *
 * Remplit les 7 colonnes seasonality_* des records historiques de
 * `wheel_validation_records` dont `seasonality_score_at_scan IS NULL`.
 *
 * Mode cache-only (défaut) :
 *   - Lit UNIQUEMENT seasonality_cache via buildSeasonalitySnapshotFromCache.
 *   - AUCUN appel Yahoo / réseau / fetch.
 *
 * Mode fetch-missing (fetchMissing=true + dryRun=false) :
 *   - Pour tickers sans cache : computeAndPersistSeasonalityBundle puis relit le cache.
 *   - Yahoo contrôlé, séquentiel (maxConcurrency=1), délai entre tickers.
 *
 * Mode fetch-missing dry-run (fetchMissing=true + dryRun=true) :
 *   - AUCUN Yahoo — indique seulement would_fetch_and_update.
 *
 * Garanties communes :
 *   - N'écrase JAMAIS un record déjà rempli (WHERE seasonality_score_at_scan IS NULL).
 *   - Ne touche qu'aux 7 colonnes seasonality_*.
 */

import path from "node:path";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { buildSeasonalitySnapshotFromCache } from "./seasonalitySnapshot.js";
import { computeAndPersistSeasonalityBundle } from "../seasonality/seasonalityBundleCompute.js";

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");
const DEFAULT_FETCH_DELAY_MS = 3000;
const MAX_FETCH_LIMIT = 10;

const SEASONALITY_COLUMNS = Object.freeze([
  "seasonality_score_at_scan",
  "seasonality_win_rate_at_scan",
  "seasonality_best_window_start",
  "seasonality_best_window_end",
  "seasonality_direction",
  "seasonality_confidence",
  "seasonality_snapshot_version",
]);

// Patch Journal POP Snapshot V2 — colonnes décisionnelles séparées.
// OPTIONNELLES : remplies UNIQUEMENT si présentes dans la table (DB migrée) et
// dans le même UPDATE conservateur (WHERE seasonality_score_at_scan IS NULL).
// Garanties : ne touche jamais un record déjà rempli, n'écrase pas les anciens
// champs, n'altère pas seasonality_score_at_scan.
const SEASONALITY_V2_COLUMNS = Object.freeze([
  "seasonality_weekly_score_at_scan",
  "seasonality_weekly_win_rate_at_scan",
  "seasonality_annual_score_at_scan",
  "seasonality_annual_win_rate_at_scan",
  "seasonality_annual_window_label_at_scan",
  "seasonality_csp_score_at_scan",
  "seasonality_cc_score_at_scan",
  "seasonality_wheel_verdict_at_scan",
  "seasonality_context_at_scan",
]);

const SAMPLE_LIMIT = 25;

function normalizeSymbol(value) {
  return String(value ?? "").trim().toUpperCase();
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Un snapshot n'est ÉCRIVABLE dans Journal POP que s'il est décisionnellement
 * complet : le cœur de décision doit être présent. Empêche d'écrire un snapshot
 * partiel (cas OKLO observé en runtime : winRate/window/version présents mais
 * score/direction/confidence null ⇒ entête décisionnel inexploitable).
 *
 * Minimum requis :
 *   - seasonality_score_at_scan : nombre fini
 *   - seasonality_direction : string non vide
 *   - seasonality_confidence : string non vide
 *   - seasonality_snapshot_version : string non vide
 *
 * NB : ne change pas le calcul de saisonnalité — c'est une garde de validation
 * côté backfill uniquement.
 */
function isDecisionCompleteSnapshot(snapshot) {
  return (
    !!snapshot &&
    isFiniteNumber(snapshot.seasonality_score_at_scan) &&
    isNonEmptyString(snapshot.seasonality_direction) &&
    isNonEmptyString(snapshot.seasonality_confidence) &&
    isNonEmptyString(snapshot.seasonality_snapshot_version)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Exécute le backfill saisonnalité sur le Journal POP.
 *
 * @param {object} [options]
 * @param {boolean} [options.dryRun=true]       false ⇒ écrit réellement les UPDATE (+ fetch si fetchMissing).
 * @param {boolean} [options.fetchMissing=false] true ⇒ tente fetch Yahoo pour tickers sans cache (write seulement).
 * @param {number|null} [options.limit]          nombre max de tickers traités.
 * @param {string[]|null} [options.symbols]      restreint à certains symboles.
 * @param {number} [options.delayMs=3000]        délai min entre fetchs Yahoo (write + fetchMissing).
 * @param {string} [options.sqlitePath]            chemin de la base Journal.
 * @param {object} [options.conn]                connexion node:sqlite injectée (tests).
 * @param {(symbol: string) => object|null} [options.buildSnapshot]
 * @param {(symbol: string) => Promise<object>} [options.fetchBundle]
 *        fetcher injectable (défaut: computeAndPersistSeasonalityBundle) — tests uniquement.
 * @param {object} [options.cache]
 * @param {object} [options.cacheOptions]
 * @returns {object} résumé structuré du backfill.
 */
export async function runJournalSeasonalityBackfill(options = {}) {
  const startedAt = Date.now();
  const dryRun = options.dryRun !== false;
  const fetchMissing = options.fetchMissing === true;
  const delayMs = Number.isFinite(Number(options.delayMs))
    ? Math.max(0, Math.trunc(Number(options.delayMs)))
    : DEFAULT_FETCH_DELAY_MS;
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

  const fetchBundle =
    typeof options.fetchBundle === "function"
      ? options.fetchBundle
      : (symbol) =>
          computeAndPersistSeasonalityBundle(symbol, {
            cache: options.cache,
            cacheOptions: options.cacheOptions,
          });

  const yahooEnabled = fetchMissing && !dryRun;

  const summary = {
    dryRun,
    cacheOnly: !fetchMissing,
    fetchMissing,
    yahooEnabled,
    limit,
    delayMs: fetchMissing ? delayMs : 0,
    tickersCandidates: 0,
    tickersProcessed: 0,
    tickersUpdated: 0,
    tickersWouldFetch: 0,
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

    // Colonnes V2 présentes (DB migrée) — remplies dans le même UPDATE conservateur.
    const presentV2Columns = SEASONALITY_V2_COLUMNS.filter((c) => columns.has(c));

    const countNullStmt = conn.prepare(
      "SELECT COUNT(*) AS cnt FROM wheel_validation_records WHERE symbol = @symbol AND seasonality_score_at_scan IS NULL"
    );
    const setClauses = [
      "seasonality_score_at_scan = @seasonality_score_at_scan",
      "seasonality_win_rate_at_scan = @seasonality_win_rate_at_scan",
      "seasonality_best_window_start = @seasonality_best_window_start",
      "seasonality_best_window_end = @seasonality_best_window_end",
      "seasonality_direction = @seasonality_direction",
      "seasonality_confidence = @seasonality_confidence",
      "seasonality_snapshot_version = @seasonality_snapshot_version",
      ...presentV2Columns.map((c) => `${c} = @${c}`),
    ];
    const updateStmt = conn.prepare(`
      UPDATE wheel_validation_records SET
        ${setClauses.join(",\n        ")}
      WHERE symbol = @symbol AND seasonality_score_at_scan IS NULL
    `);

    for (let i = 0; i < selected.length; i++) {
      const candidate = selected[i];
      const symbol = normalizeSymbol(candidate?.symbol);
      summary.tickersProcessed += 1;
      let didFetchThisTicker = false;

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
        if (!fetchMissing) {
          summary.tickersSkipped += 1;
          bumpReason("no_cache_or_invalid");
          pushSample({ symbol, status: "skipped", reason: "no_cache_or_invalid" });
          continue;
        }

        const nullCountBefore = Number(countNullStmt.get({ symbol })?.cnt ?? 0);
        if (nullCountBefore === 0) {
          summary.tickersSkipped += 1;
          bumpReason("no_null_records");
          pushSample({ symbol, status: "skipped", reason: "no_null_records" });
          continue;
        }

        if (dryRun) {
          summary.tickersWouldFetch += 1;
          summary.recordsWouldUpdate += nullCountBefore;
          summary.tickersUpdated += 1;
          pushSample({
            symbol,
            status: "would_fetch_and_update",
            recordsWouldUpdate: nullCountBefore,
          });
          continue;
        }

        let fetchResult;
        try {
          fetchResult = await fetchBundle(symbol);
        } catch (error) {
          summary.tickersSkipped += 1;
          bumpReason("fetch_failed_or_invalid");
          summary.errors.push({ scope: "fetch", symbol, message: String(error?.message ?? error) });
          pushSample({ symbol, status: "skipped", reason: "fetch_failed_or_invalid" });
          continue;
        }

        if (!fetchResult?.ok) {
          summary.tickersSkipped += 1;
          bumpReason("fetch_failed_or_invalid");
          summary.errors.push({
            scope: "fetch",
            symbol,
            message: String(fetchResult?.error ?? "fetch_failed_or_invalid"),
          });
          pushSample({ symbol, status: "skipped", reason: "fetch_failed_or_invalid" });
          continue;
        }

        didFetchThisTicker = true;

        try {
          snapshot = buildSnapshot(symbol);
        } catch (error) {
          summary.tickersSkipped += 1;
          bumpReason("fetch_failed_or_invalid");
          summary.errors.push({ scope: "snapshot_after_fetch", symbol, message: String(error?.message ?? error) });
          pushSample({ symbol, status: "skipped", reason: "fetch_failed_or_invalid" });
          if (i < selected.length - 1 && delayMs > 0) await sleep(delayMs);
          continue;
        }

        if (!snapshot) {
          summary.tickersSkipped += 1;
          bumpReason("fetch_failed_or_invalid");
          pushSample({ symbol, status: "skipped", reason: "fetch_failed_or_invalid" });
          if (i < selected.length - 1 && delayMs > 0) await sleep(delayMs);
          continue;
        }
      }

      // Garde anti-snapshot partiel : on n'écrit JAMAIS dans Journal POP un
      // snapshot décisionnellement incomplet (score/direction/confidence/version
      // requis). Compté ni comme updated ni dans recordsWouldUpdate.
      if (!isDecisionCompleteSnapshot(snapshot)) {
        const reason = didFetchThisTicker ? "fetch_incomplete_snapshot" : "incomplete_snapshot";
        summary.tickersSkipped += 1;
        bumpReason(reason);
        pushSample({
          symbol,
          status: "skipped",
          reason,
          version: snapshot?.seasonality_snapshot_version ?? null,
        });
        if (didFetchThisTicker && i < selected.length - 1 && delayMs > 0) {
          await sleep(delayMs);
        }
        continue;
      }

      const nullCount = Number(countNullStmt.get({ symbol })?.cnt ?? 0);
      if (nullCount === 0) {
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
        const updateParams = {
          symbol,
          seasonality_score_at_scan: snapshot.seasonality_score_at_scan ?? null,
          seasonality_win_rate_at_scan: snapshot.seasonality_win_rate_at_scan ?? null,
          seasonality_best_window_start: snapshot.seasonality_best_window_start ?? null,
          seasonality_best_window_end: snapshot.seasonality_best_window_end ?? null,
          seasonality_direction: snapshot.seasonality_direction ?? null,
          seasonality_confidence: snapshot.seasonality_confidence ?? null,
          seasonality_snapshot_version: snapshot.seasonality_snapshot_version ?? null,
        };
        // V2 : seulement les colonnes présentes (sinon param inconnu côté SQL).
        for (const c of presentV2Columns) {
          updateParams[c] = snapshot[c] ?? null;
        }
        const result = updateStmt.run(updateParams);
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

      if (didFetchThisTicker && i < selected.length - 1 && delayMs > 0) {
        await sleep(delayMs);
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

export { MAX_FETCH_LIMIT, DEFAULT_FETCH_DELAY_MS };
