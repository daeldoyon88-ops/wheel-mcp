/**
 * Scan Funnel Archive Store — Phase 1 (read-only forensic archive).
 *
 * Persiste une trace compacte du pipeline univers → watchlist → Yahoo → IBKR → UI
 * par scanSessionId, afin de répondre après coup à « pourquoi tel ticker n'est pas
 * apparu dans le dashboard ? ».
 *
 * Contraintes de conception :
 *   - Réutilise la MÊME base SQLite que Journal POP (sqlitePath injecté).
 *   - N'altère NI la sélection du scan, NI le ranking, NI le scoring.
 *   - Ne refetch JAMAIS Yahoo/IBKR : il ne reçoit que des données déjà calculées
 *     côté dashboard.
 *   - Ne stocke ni rawJson, ni chaînes d'options, ni greeks complets.
 *   - Idempotent par scanSessionId (re-archiver remplace les events, sans doublon).
 *
 * Tables (idempotentes) :
 *   scan_funnel_sessions       — un résumé par scanSessionId
 *   scan_funnel_ticker_events  — N events par scanSessionId (cap MAX_EVENTS)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

/** Garde-fou : nombre maximum d'events archivés par session. */
export const MAX_EVENTS = 800;

function toInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toIntBool(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value == null) return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n ? 1 : 0;
  return null;
}

function toText(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function normalizeSymbol(symbol) {
  return String(symbol ?? "").trim().toUpperCase();
}

/** Sérialise un objet compact en JSON, en supprimant les clés volumineuses interdites. */
function compactJson(value) {
  if (value == null) return null;
  if (typeof value !== "object") return null;
  const FORBIDDEN = new Set(["rawJson", "optionChain", "options", "greeks", "chain"]);
  const clean = {};
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN.has(k)) continue;
    if (v === undefined) continue;
    clean[k] = v;
  }
  if (Object.keys(clean).length === 0) return null;
  try {
    return JSON.stringify(clean);
  } catch {
    return null;
  }
}

export function createScanFunnelArchiveStore(options = {}) {
  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
  const maxEvents = Math.max(1, Number(options.maxEvents) || MAX_EVENTS);
  let db = null;
  let initialized = false;

  async function ensureParentDir(filePath) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  }

  function ensureDbSync() {
    if (db) return db;
    db = new DatabaseSync(sqlitePath);
    return db;
  }

  async function ensureInitialized() {
    if (initialized) return;
    await ensureParentDir(sqlitePath);
    const conn = ensureDbSync();
    conn.exec(`
      CREATE TABLE IF NOT EXISTS scan_funnel_sessions (
        scan_session_id TEXT PRIMARY KEY,
        scan_timestamp TEXT,
        selected_expiration TEXT,
        dte_at_scan INTEGER,
        pool_source TEXT,
        capture_source TEXT,
        pre_ibkr_count INTEGER,
        yahoo_sent_count INTEGER,
        yahoo_returned_count INTEGER,
        ibkr_sent_count INTEGER,
        ibkr_tested_count INTEGER,
        ibkr_retained_count INTEGER,
        ibkr_rejected_count INTEGER,
        ui_displayed_count INTEGER,
        journal_pop_captured INTEGER,
        metadata_json TEXT,
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS scan_funnel_ticker_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_session_id TEXT,
        symbol TEXT,
        stage TEXT,
        reason TEXT,
        rank INTEGER,
        sent_to_ibkr INTEGER,
        ibkr_outcome TEXT,
        metadata_json TEXT,
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_sfte_session ON scan_funnel_ticker_events(scan_session_id);
      CREATE INDEX IF NOT EXISTS idx_sfte_symbol_created ON scan_funnel_ticker_events(symbol, created_at);
      CREATE INDEX IF NOT EXISTS idx_sfs_created ON scan_funnel_sessions(created_at);
    `);
    initialized = true;
  }

  const UPSERT_SESSION_SQL = `
    INSERT INTO scan_funnel_sessions (
      scan_session_id, scan_timestamp, selected_expiration, dte_at_scan,
      pool_source, capture_source, pre_ibkr_count, yahoo_sent_count,
      yahoo_returned_count, ibkr_sent_count, ibkr_tested_count,
      ibkr_retained_count, ibkr_rejected_count, ui_displayed_count,
      journal_pop_captured, metadata_json, created_at
    ) VALUES (
      @scan_session_id, @scan_timestamp, @selected_expiration, @dte_at_scan,
      @pool_source, @capture_source, @pre_ibkr_count, @yahoo_sent_count,
      @yahoo_returned_count, @ibkr_sent_count, @ibkr_tested_count,
      @ibkr_retained_count, @ibkr_rejected_count, @ui_displayed_count,
      @journal_pop_captured, @metadata_json, @created_at
    )
    ON CONFLICT(scan_session_id) DO UPDATE SET
      scan_timestamp=excluded.scan_timestamp,
      selected_expiration=excluded.selected_expiration,
      dte_at_scan=excluded.dte_at_scan,
      pool_source=excluded.pool_source,
      capture_source=excluded.capture_source,
      pre_ibkr_count=excluded.pre_ibkr_count,
      yahoo_sent_count=excluded.yahoo_sent_count,
      yahoo_returned_count=excluded.yahoo_returned_count,
      ibkr_sent_count=excluded.ibkr_sent_count,
      ibkr_tested_count=excluded.ibkr_tested_count,
      ibkr_retained_count=excluded.ibkr_retained_count,
      ibkr_rejected_count=excluded.ibkr_rejected_count,
      ui_displayed_count=excluded.ui_displayed_count,
      journal_pop_captured=excluded.journal_pop_captured,
      metadata_json=excluded.metadata_json,
      created_at=excluded.created_at
  `;

  const INSERT_EVENT_SQL = `
    INSERT INTO scan_funnel_ticker_events (
      scan_session_id, symbol, stage, reason, rank, sent_to_ibkr,
      ibkr_outcome, metadata_json, created_at
    ) VALUES (
      @scan_session_id, @symbol, @stage, @reason, @rank, @sent_to_ibkr,
      @ibkr_outcome, @metadata_json, @created_at
    )
  `;

  /** Normalise + dédoublonne (symbol+stage) la liste d'events reçue. */
  function normalizeEvents(rawEvents) {
    const list = Array.isArray(rawEvents) ? rawEvents : [];
    const seen = new Set();
    const out = [];
    for (const e of list) {
      const symbol = normalizeSymbol(e?.symbol);
      const stage = toText(e?.stage);
      if (!symbol || !stage) continue;
      const key = `${symbol}|${stage}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        symbol,
        stage,
        reason: toText(e?.reason),
        rank: toInt(e?.rank),
        sent_to_ibkr: toIntBool(e?.sentToIbkr ?? e?.sent_to_ibkr),
        ibkr_outcome: toText(e?.ibkrOutcome ?? e?.ibkr_outcome),
        metadata_json: compactJson(e?.metadata),
      });
    }
    return out;
  }

  /**
   * Archive une session funnel + ses events de façon idempotente.
   * Re-archiver le même scanSessionId remplace entièrement ses events.
   *
   * @param {object} payload  payload compact construit côté dashboard
   * @returns {Promise<{ok:boolean, scanSessionId:string, eventsArchived:number, error?:string}>}
   */
  async function archiveSession(payload = {}) {
    await ensureInitialized();
    const scanSessionId = toText(payload?.scanSessionId);
    if (!scanSessionId) {
      return { ok: false, scanSessionId: null, eventsArchived: 0, error: "scanSessionId required" };
    }

    const events = normalizeEvents(payload?.events);
    if (events.length > maxEvents) {
      return {
        ok: false,
        scanSessionId,
        eventsArchived: 0,
        error: `too many events: ${events.length} > ${maxEvents}`,
      };
    }

    const nowIso = new Date().toISOString();
    const counts = payload?.counts && typeof payload.counts === "object" ? payload.counts : {};
    const sessionRow = {
      scan_session_id: scanSessionId,
      scan_timestamp: toText(payload?.scanTimestamp),
      selected_expiration: toText(payload?.selectedExpiration),
      dte_at_scan: toInt(payload?.dteAtScan),
      pool_source: toText(payload?.poolSource),
      capture_source: toText(payload?.captureSource),
      pre_ibkr_count: toInt(counts?.preIbkrCount),
      yahoo_sent_count: toInt(counts?.yahooSentCount),
      yahoo_returned_count: toInt(counts?.yahooReturnedCount),
      ibkr_sent_count: toInt(counts?.ibkrSentCount),
      ibkr_tested_count: toInt(counts?.ibkrTestedCount),
      ibkr_retained_count: toInt(counts?.ibkrRetainedCount),
      ibkr_rejected_count: toInt(counts?.ibkrRejectedCount),
      ui_displayed_count: toInt(counts?.uiDisplayedCount),
      journal_pop_captured: toInt(counts?.journalPopCaptured ?? payload?.journalPopCaptured),
      metadata_json: compactJson(payload?.metadata),
      created_at: nowIso,
    };

    const conn = ensureDbSync();
    const upsertSession = conn.prepare(UPSERT_SESSION_SQL);
    const deleteEvents = conn.prepare(
      "DELETE FROM scan_funnel_ticker_events WHERE scan_session_id = @scan_session_id"
    );
    const insertEvent = conn.prepare(INSERT_EVENT_SQL);

    conn.exec("BEGIN");
    try {
      // Idempotence : on purge les events existants de cette session avant réinsertion.
      deleteEvents.run({ scan_session_id: scanSessionId });
      upsertSession.run(sessionRow);
      for (const e of events) {
        insertEvent.run({
          scan_session_id: scanSessionId,
          symbol: e.symbol,
          stage: e.stage,
          reason: e.reason,
          rank: e.rank,
          sent_to_ibkr: e.sent_to_ibkr,
          ibkr_outcome: e.ibkr_outcome,
          metadata_json: e.metadata_json,
          created_at: nowIso,
        });
      }
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch (_rollbackError) {
        // Preserve original failure.
      }
      throw error;
    }

    return { ok: true, scanSessionId, eventsArchived: events.length };
  }

  function parseMetadata(raw) {
    if (raw == null || raw === "") return null;
    try {
      const parsed = JSON.parse(String(raw));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function mapEventRow(row) {
    return {
      id: row.id,
      symbol: row.symbol,
      stage: row.stage,
      reason: row.reason,
      rank: row.rank,
      sentToIbkr: row.sent_to_ibkr == null ? null : row.sent_to_ibkr === 1,
      ibkrOutcome: row.ibkr_outcome,
      metadata: parseMetadata(row.metadata_json),
      createdAt: row.created_at,
    };
  }

  /** Retourne la session + ses events, ou null si absente. */
  async function getSession(scanSessionId) {
    await ensureInitialized();
    const id = toText(scanSessionId);
    if (!id) return null;
    const conn = ensureDbSync();
    const session = conn
      .prepare("SELECT * FROM scan_funnel_sessions WHERE scan_session_id = @id")
      .get({ id });
    if (!session) return null;
    const events = conn
      .prepare(
        "SELECT * FROM scan_funnel_ticker_events WHERE scan_session_id = @id ORDER BY id ASC"
      )
      .all({ id })
      .map(mapEventRow);
    return {
      session: { ...session, metadata: parseMetadata(session.metadata_json) },
      events,
    };
  }

  /** Liste les sessions les plus récentes (résumé sans events). */
  async function listSessions({ limit = 50 } = {}) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const lim = Math.min(Math.max(toInt(limit) ?? 50, 1), 500);
    const rows = conn
      .prepare(
        `SELECT s.*, (
            SELECT COUNT(*) FROM scan_funnel_ticker_events e
            WHERE e.scan_session_id = s.scan_session_id
          ) AS event_count
         FROM scan_funnel_sessions s
         ORDER BY s.created_at DESC, s.scan_session_id DESC
         LIMIT @lim`
      )
      .all({ lim });
    return rows.map((row) => ({ ...row, metadata: parseMetadata(row.metadata_json) }));
  }

  /**
   * Purge optionnelle : garde au plus maxSessions sessions et/ou supprime celles
   * plus vieilles que ttlDays. Best-effort, ne throw pas si les bornes sont absentes.
   */
  async function purgeOldSessions({ maxSessions = null, ttlDays = null } = {}) {
    await ensureInitialized();
    const conn = ensureDbSync();
    let removed = 0;
    const toRemove = new Set();

    const ttl = toInt(ttlDays);
    if (ttl != null && ttl > 0) {
      const cutoff = new Date(Date.now() - ttl * 24 * 60 * 60 * 1000).toISOString();
      const old = conn
        .prepare("SELECT scan_session_id FROM scan_funnel_sessions WHERE created_at < @cutoff")
        .all({ cutoff });
      for (const r of old) toRemove.add(r.scan_session_id);
    }

    const max = toInt(maxSessions);
    if (max != null && max > 0) {
      const overflow = conn
        .prepare(
          `SELECT scan_session_id FROM scan_funnel_sessions
           ORDER BY created_at DESC, scan_session_id DESC
           LIMIT -1 OFFSET @max`
        )
        .all({ max });
      for (const r of overflow) toRemove.add(r.scan_session_id);
    }

    if (toRemove.size === 0) return { ok: true, removed: 0 };

    const deleteEvents = conn.prepare(
      "DELETE FROM scan_funnel_ticker_events WHERE scan_session_id = @id"
    );
    const deleteSession = conn.prepare(
      "DELETE FROM scan_funnel_sessions WHERE scan_session_id = @id"
    );
    conn.exec("BEGIN");
    try {
      for (const id of toRemove) {
        deleteEvents.run({ id });
        const res = deleteSession.run({ id });
        removed += Number(res?.changes ?? 0);
      }
      conn.exec("COMMIT");
    } catch (error) {
      try {
        conn.exec("ROLLBACK");
      } catch (_rollbackError) {
        // Preserve original failure.
      }
      throw error;
    }
    return { ok: true, removed };
  }

  return {
    sqlitePath,
    maxEvents,
    ensureInitialized,
    archiveSession,
    getSession,
    listSessions,
    purgeOldSessions,
  };
}
