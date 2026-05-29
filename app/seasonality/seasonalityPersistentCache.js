/**
 * Seasonality Persistent Cache — SQLite, expiration quotidienne UTC.
 * Stocke le bundle (calendar + short-term + windows + chart-3y) par ticker.
 * DB partagée : data/wheelValidationJournal.sqlite
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { isValidBundlePayload } from "./seasonalityBundleValidation.js";

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

export const SEASONALITY_CACHE_VERSION = "annual-display-v1";

function safeExec(conn, sql) {
  try { conn.exec(sql); } catch (_) {}
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export function createSeasonalityPersistentCache(options = {}) {
  const sqlitePath   = options.sqlitePath   ?? DEFAULT_SQLITE_PATH;
  const cacheVersion = options.cacheVersion ?? SEASONALITY_CACHE_VERSION;

  let db          = null;
  let initialized = false;

  function _db() {
    if (!db) db = new DatabaseSync(sqlitePath);
    return db;
  }

  async function ensureInitialized() {
    if (initialized) return;
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    const conn = _db();
    conn.exec(`
      CREATE TABLE IF NOT EXISTS seasonality_cache (
        ticker           TEXT NOT NULL,
        cache_version    TEXT NOT NULL,
        payload_json     TEXT NOT NULL,
        computed_at      TEXT NOT NULL,
        source_last_date TEXT,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (ticker, cache_version)
      );
    `);
    safeExec(conn, `
      CREATE INDEX IF NOT EXISTS idx_scache_ticker_date
      ON seasonality_cache (ticker, computed_at);
    `);
    initialized = true;
  }

  function getCache(ticker) {
    const sym = String(ticker ?? "").trim().toUpperCase();
    if (!sym) return null;
    const conn = _db();
    const row = conn.prepare(
      `SELECT ticker, cache_version, payload_json, computed_at, source_last_date, updated_at
       FROM seasonality_cache WHERE ticker = ? AND cache_version = ?`
    ).get(sym, cacheVersion);
    if (!row) return null;

    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch (_) {
      // Entrée corrompue — supprimer pour éviter les lectures cassées
      conn.prepare(`DELETE FROM seasonality_cache WHERE ticker = ? AND cache_version = ?`)
          .run(sym, cacheVersion);
      return null;
    }

    // Bundle logiquement invalide — supprimer pour forcer un recalcul
    if (!isValidBundlePayload(payload)) {
      conn.prepare(`DELETE FROM seasonality_cache WHERE ticker = ? AND cache_version = ?`)
          .run(sym, cacheVersion);
      return null;
    }

    const entry = {
      ticker:         row.ticker,
      payload,
      computedAt:     row.computed_at,
      sourceLastDate: row.source_last_date ?? null,
      updatedAt:      row.updated_at,
      cacheVersion:   row.cache_version,
    };
    entry.fresh = isFresh(entry);
    return entry;
  }

  function setCache(ticker, payload, meta = {}) {
    const sym = String(ticker ?? "").trim().toUpperCase();
    if (!sym) return false;
    if (!isValidBundlePayload(payload)) return false;
    const conn           = _db();
    const computedAt     = meta.computedAt      ?? todayUtc();
    const sourceLastDate = meta.sourceLastDate   ?? null;
    const updatedAt      = new Date().toISOString();
    const payloadJson    = JSON.stringify(payload ?? null);
    conn.prepare(
      `INSERT OR REPLACE INTO seasonality_cache
       (ticker, cache_version, payload_json, computed_at, source_last_date, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(sym, cacheVersion, payloadJson, computedAt, sourceLastDate, updatedAt);
    return true;
  }

  function clearCache(ticker) {
    const sym = String(ticker ?? "").trim().toUpperCase();
    if (!sym) return false;
    const result = _db().prepare(
      `DELETE FROM seasonality_cache WHERE ticker = ? AND cache_version = ?`
    ).run(sym, cacheVersion);
    return result.changes > 0;
  }

  function clearCaches(tickers) {
    const list = (Array.isArray(tickers) ? tickers : [])
      .map(t => String(t ?? "").trim().toUpperCase())
      .filter(Boolean);
    const cleared = [];
    for (const sym of list) {
      if (clearCache(sym)) cleared.push(sym);
    }
    return cleared;
  }

  function isFresh(entry) {
    if (!entry?.computedAt) return false;
    return entry.computedAt === todayUtc();
  }

  function cleanOldVersions() {
    _db().prepare(`DELETE FROM seasonality_cache WHERE cache_version != ?`).run(cacheVersion);
  }

  function getCacheStatus() {
    const conn = _db();
    const totalRow  = conn.prepare(`SELECT COUNT(*) as cnt FROM seasonality_cache`).get();
    const byVersion = conn.prepare(
      `SELECT cache_version, COUNT(*) as cnt FROM seasonality_cache GROUP BY cache_version`
    ).all();
    const rangeRow  = conn.prepare(
      `SELECT MIN(computed_at) as minDate, MAX(computed_at) as maxDate
       FROM seasonality_cache WHERE cache_version = ?`
    ).get(cacheVersion);
    return {
      totalEntries:   totalRow.cnt,
      byVersion:      byVersion.map(r => ({ version: r.cache_version, count: r.cnt })),
      currentVersion: cacheVersion,
      minComputedAt:  rangeRow?.minDate ?? null,
      maxComputedAt:  rangeRow?.maxDate ?? null,
    };
  }

  return {
    ensureInitialized,
    getCache,
    setCache,
    isFresh,
    cleanOldVersions,
    getCacheStatus,
    clearCache,
    clearCaches,
  };
}
