import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

// EWMA smoothing factor for avgSpreadPct / avgPremiumYield / avgYahooRank.
const EWMA_ALPHA = 0.25;

function toReal(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function ewma(previous, sample, alpha = EWMA_ALPHA) {
  const x = toReal(sample);
  if (x == null) return previous ?? null;
  const prev = toReal(previous);
  if (prev == null) return x;
  return alpha * x + (1 - alpha) * prev;
}

function normalizeSymbol(symbol) {
  return String(symbol ?? "").trim().toUpperCase();
}

function normalizeReason(reason) {
  const r = String(reason ?? "").trim();
  return r === "" ? "unknown" : r;
}

/**
 * Map a free-form IBKR reason/status to one of the three memory outcomes.
 * - retained : ticker kept by IBKR
 * - no_data  : IBKR/TWS could not return usable data (timeout, unavailable, empty)
 * - rejected : IBKR returned data but the ticker did not qualify
 */
export function classifyScanOutcome({ status, reason } = {}) {
  const s = String(status ?? "").trim().toLowerCase();
  if (s === "kept" || s === "retained") return "retained";
  const r = String(reason ?? "").trim().toLowerCase();
  const blob = `${s} ${r}`;
  if (
    s === "timeout" ||
    /timeout|ibkr_unavailable|unavailable|no[_\s-]?market[_\s-]?data|no[_\s-]?data|nodata|empty|connection|tws/.test(blob)
  ) {
    return "no_data";
  }
  return "rejected";
}

/** A reject reason that is about an excessively wide bid/ask spread. */
function isWideSpreadReason(reason) {
  return /spread/i.test(String(reason ?? ""));
}

/** A reject reason that is about insufficient premium / yield. */
function isNoPremiumReason(reason) {
  return /premium|prime|yield|min_premium|no_safe_candidate/i.test(String(reason ?? ""));
}

function mostFrequentReason(counts) {
  if (!counts || typeof counts !== "object") return null;
  let best = null;
  let bestCount = -1;
  for (const [reason, count] of Object.entries(counts)) {
    const c = Number(count) || 0;
    if (c > bestCount) {
      bestCount = c;
      best = reason;
    }
  }
  return best;
}

function parseReasonCounts(raw) {
  if (raw == null || raw === "") return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function createTickerScanMemoryStore(options = {}) {
  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
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
      CREATE TABLE IF NOT EXISTS ticker_scan_memory (
        symbol TEXT PRIMARY KEY,
        timesInTop250 INTEGER DEFAULT 0,
        timesSentIbkr INTEGER DEFAULT 0,
        timesIbkrRetained INTEGER DEFAULT 0,
        timesIbkrRejected INTEGER DEFAULT 0,
        timesNoData INTEGER DEFAULT 0,
        avgSpreadPct REAL,
        avgPremiumYield REAL,
        avgYahooRank REAL,
        mainRejectReason TEXT,
        rejectReasonCounts TEXT,
        consecutiveRejects INTEGER DEFAULT 0,
        consecutiveNoData INTEGER DEFAULT 0,
        consecutiveWideSpread INTEGER DEFAULT 0,
        consecutiveNoPremium INTEGER DEFAULT 0,
        firstSeenAt TEXT,
        lastScannedAt TEXT,
        lastIbkrTestAt TEXT,
        lastRetainedAt TEXT,
        updatedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tsm_lastIbkrTestAt ON ticker_scan_memory(lastIbkrTestAt);
      CREATE INDEX IF NOT EXISTS idx_tsm_timesIbkrRetained ON ticker_scan_memory(timesIbkrRetained);
      CREATE INDEX IF NOT EXISTS idx_tsm_consecutiveRejects ON ticker_scan_memory(consecutiveRejects);
      CREATE INDEX IF NOT EXISTS idx_tsm_mainRejectReason ON ticker_scan_memory(mainRejectReason);
    `);
    initialized = true;
  }

  function readRow(conn, symbol) {
    return conn.prepare("SELECT * FROM ticker_scan_memory WHERE symbol = @symbol").get({ symbol });
  }

  const UPSERT_SQL = `
    INSERT INTO ticker_scan_memory (
      symbol, timesInTop250, timesSentIbkr, timesIbkrRetained, timesIbkrRejected, timesNoData,
      avgSpreadPct, avgPremiumYield, avgYahooRank, mainRejectReason, rejectReasonCounts,
      consecutiveRejects, consecutiveNoData, consecutiveWideSpread, consecutiveNoPremium,
      firstSeenAt, lastScannedAt, lastIbkrTestAt, lastRetainedAt, updatedAt
    ) VALUES (
      @symbol, @timesInTop250, @timesSentIbkr, @timesIbkrRetained, @timesIbkrRejected, @timesNoData,
      @avgSpreadPct, @avgPremiumYield, @avgYahooRank, @mainRejectReason, @rejectReasonCounts,
      @consecutiveRejects, @consecutiveNoData, @consecutiveWideSpread, @consecutiveNoPremium,
      @firstSeenAt, @lastScannedAt, @lastIbkrTestAt, @lastRetainedAt, @updatedAt
    )
    ON CONFLICT(symbol) DO UPDATE SET
      timesInTop250=excluded.timesInTop250,
      timesSentIbkr=excluded.timesSentIbkr,
      timesIbkrRetained=excluded.timesIbkrRetained,
      timesIbkrRejected=excluded.timesIbkrRejected,
      timesNoData=excluded.timesNoData,
      avgSpreadPct=excluded.avgSpreadPct,
      avgPremiumYield=excluded.avgPremiumYield,
      avgYahooRank=excluded.avgYahooRank,
      mainRejectReason=excluded.mainRejectReason,
      rejectReasonCounts=excluded.rejectReasonCounts,
      consecutiveRejects=excluded.consecutiveRejects,
      consecutiveNoData=excluded.consecutiveNoData,
      consecutiveWideSpread=excluded.consecutiveWideSpread,
      consecutiveNoPremium=excluded.consecutiveNoPremium,
      firstSeenAt=excluded.firstSeenAt,
      lastScannedAt=excluded.lastScannedAt,
      lastIbkrTestAt=excluded.lastIbkrTestAt,
      lastRetainedAt=excluded.lastRetainedAt,
      updatedAt=excluded.updatedAt
  `;

  /**
   * Persist the outcome of a single IBKR scan, one row per tested ticker.
   *
   * @param {object} input
   * @param {Array<{symbol:string,status?:string,reason?:string,spreadPct?:number,premiumYield?:number,yahooRank?:number}>} input.entries
   * @param {boolean} [input.suspiciousEmpty]  ibkrSuspiciousEmpty flag — skip writes entirely when true.
   * @param {string}  [input.scanTimestamp]    ISO timestamp of the scan (defaults to now).
   * @returns {Promise<{ok:boolean, skipped:boolean, reason?:string, updated:number}>}
   */
  async function recordScan(input = {}) {
    await ensureInitialized();
    const nowIso = new Date().toISOString();
    const scanTimestamp =
      typeof input.scanTimestamp === "string" && input.scanTimestamp ? input.scanTimestamp : nowIso;

    // Guard-rail 1 — IBKR/TWS returned nothing usable for the whole batch.
    if (input.suspiciousEmpty === true) {
      return { ok: true, skipped: true, reason: "ibkr_suspicious_empty", updated: 0 };
    }

    const rawEntries = Array.isArray(input.entries) ? input.entries : [];
    const entries = [];
    const seen = new Set();
    for (const e of rawEntries) {
      const symbol = normalizeSymbol(e?.symbol);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      entries.push({
        symbol,
        outcome: classifyScanOutcome({ status: e?.status, reason: e?.reason }),
        reason: normalizeReason(e?.reason),
        spreadPct: toReal(e?.spreadPct),
        premiumYield: toReal(e?.premiumYield),
        yahooRank: toReal(e?.yahooRank),
      });
    }

    if (entries.length === 0) {
      return { ok: true, skipped: true, reason: "no_entries", updated: 0 };
    }

    // Guard-rail 2 — the whole batch looks like an IBKR/TWS failure (nothing
    // retained and every tested ticker came back as no_data). Do not penalize.
    const retainedCount = entries.filter((e) => e.outcome === "retained").length;
    const noDataCount = entries.filter((e) => e.outcome === "no_data").length;
    if (retainedCount === 0 && noDataCount === entries.length) {
      return { ok: true, skipped: true, reason: "batch_ibkr_failure", updated: 0 };
    }

    const conn = ensureDbSync();
    const upsert = conn.prepare(UPSERT_SQL);
    let updated = 0;
    conn.exec("BEGIN");
    try {
      for (const entry of entries) {
        const prev = readRow(conn, entry.symbol) ?? {};
        const reasonCounts = parseReasonCounts(prev.rejectReasonCounts);

        // Counters (every entry was in the Yahoo Top 250 and sent to IBKR).
        const row = {
          symbol: entry.symbol,
          timesInTop250: (Number(prev.timesInTop250) || 0) + 1,
          timesSentIbkr: (Number(prev.timesSentIbkr) || 0) + 1,
          timesIbkrRetained: Number(prev.timesIbkrRetained) || 0,
          timesIbkrRejected: Number(prev.timesIbkrRejected) || 0,
          timesNoData: Number(prev.timesNoData) || 0,
          avgSpreadPct: ewma(prev.avgSpreadPct, entry.spreadPct),
          avgPremiumYield: ewma(prev.avgPremiumYield, entry.premiumYield),
          avgYahooRank: ewma(prev.avgYahooRank, entry.yahooRank),
          mainRejectReason: prev.mainRejectReason ?? null,
          rejectReasonCounts: null,
          consecutiveRejects: Number(prev.consecutiveRejects) || 0,
          consecutiveNoData: Number(prev.consecutiveNoData) || 0,
          consecutiveWideSpread: Number(prev.consecutiveWideSpread) || 0,
          consecutiveNoPremium: Number(prev.consecutiveNoPremium) || 0,
          firstSeenAt: prev.firstSeenAt ?? scanTimestamp,
          lastScannedAt: scanTimestamp,
          lastIbkrTestAt: scanTimestamp,
          lastRetainedAt: prev.lastRetainedAt ?? null,
          updatedAt: nowIso,
        };

        if (entry.outcome === "retained") {
          row.timesIbkrRetained += 1;
          row.lastRetainedAt = scanTimestamp;
          row.consecutiveRejects = 0;
          row.consecutiveNoData = 0;
          row.consecutiveWideSpread = 0;
          row.consecutiveNoPremium = 0;
        } else if (entry.outcome === "no_data") {
          row.timesNoData += 1;
          row.consecutiveNoData += 1;
          row.consecutiveRejects = 0;
          row.consecutiveWideSpread = 0;
          row.consecutiveNoPremium = 0;
        } else {
          // rejected
          row.timesIbkrRejected += 1;
          row.consecutiveRejects += 1;
          row.consecutiveNoData = 0;
          reasonCounts[entry.reason] = (Number(reasonCounts[entry.reason]) || 0) + 1;
          row.consecutiveWideSpread = isWideSpreadReason(entry.reason)
            ? row.consecutiveWideSpread + 1
            : 0;
          row.consecutiveNoPremium = isNoPremiumReason(entry.reason)
            ? row.consecutiveNoPremium + 1
            : 0;
        }

        row.rejectReasonCounts = Object.keys(reasonCounts).length ? JSON.stringify(reasonCounts) : null;
        row.mainRejectReason = mostFrequentReason(reasonCounts) ?? row.mainRejectReason;

        upsert.run(row);
        updated += 1;
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

    return { ok: true, skipped: false, updated };
  }

  async function getSymbol(symbol) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const row = readRow(conn, normalizeSymbol(symbol));
    if (!row) return null;
    return { ...row, rejectReasonCounts: parseReasonCounts(row.rejectReasonCounts) };
  }

  async function getAll() {
    await ensureInitialized();
    const conn = ensureDbSync();
    return conn
      .prepare("SELECT * FROM ticker_scan_memory")
      .all()
      .map((row) => ({ ...row, rejectReasonCounts: parseReasonCounts(row.rejectReasonCounts) }));
  }

  /** Read-only aggregated summary for the /ticker-scan-memory endpoint. */
  async function getSummary(options = {}) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const limit = Math.min(Math.max(Number(options.limit) || 15, 1), 100);
    const minTests = Math.max(Number(options.minTests) || 3, 1);

    const total = conn.prepare("SELECT COUNT(*) AS cnt FROM ticker_scan_memory").get()?.cnt ?? 0;

    const topRetained = conn
      .prepare(
        "SELECT symbol, timesIbkrRetained, timesSentIbkr, lastRetainedAt FROM ticker_scan_memory WHERE timesIbkrRetained > 0 ORDER BY timesIbkrRetained DESC, timesSentIbkr DESC LIMIT @limit"
      )
      .all({ limit });

    const topRejected = conn
      .prepare(
        "SELECT symbol, timesIbkrRejected, timesSentIbkr, mainRejectReason FROM ticker_scan_memory WHERE timesIbkrRejected > 0 ORDER BY timesIbkrRejected DESC, timesSentIbkr DESC LIMIT @limit"
      )
      .all({ limit });

    const topWideSpread = conn
      .prepare(
        "SELECT symbol, consecutiveWideSpread, avgSpreadPct, timesIbkrRejected FROM ticker_scan_memory WHERE consecutiveWideSpread > 0 ORDER BY consecutiveWideSpread DESC LIMIT @limit"
      )
      .all({ limit });

    const topNoPremium = conn
      .prepare(
        "SELECT symbol, consecutiveNoPremium, avgPremiumYield, timesIbkrRejected FROM ticker_scan_memory WHERE consecutiveNoPremium > 0 ORDER BY consecutiveNoPremium DESC LIMIT @limit"
      )
      .all({ limit });

    const topNoData = conn
      .prepare(
        "SELECT symbol, consecutiveNoData, timesNoData, timesSentIbkr FROM ticker_scan_memory WHERE consecutiveNoData > 0 ORDER BY consecutiveNoData DESC LIMIT @limit"
      )
      .all({ limit });

    const neverRetained = conn
      .prepare(
        "SELECT symbol, timesSentIbkr, timesIbkrRejected, timesNoData, mainRejectReason FROM ticker_scan_memory WHERE timesIbkrRetained = 0 AND timesSentIbkr >= @minTests ORDER BY timesSentIbkr DESC LIMIT @limit"
      )
      .all({ limit, minTests });

    const reasonRows = conn
      .prepare("SELECT rejectReasonCounts FROM ticker_scan_memory WHERE rejectReasonCounts IS NOT NULL")
      .all();
    const reasonTotals = {};
    for (const r of reasonRows) {
      const counts = parseReasonCounts(r.rejectReasonCounts);
      for (const [reason, count] of Object.entries(counts)) {
        reasonTotals[reason] = (reasonTotals[reason] || 0) + (Number(count) || 0);
      }
    }
    const topRejectReasons = Object.entries(reasonTotals)
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return {
      totalTickers: total,
      topRetained,
      topRejected,
      topWideSpread,
      topNoPremium,
      topNoData,
      neverRetained,
      topRejectReasons,
    };
  }

  return {
    sqlitePath,
    ensureInitialized,
    recordScan,
    getSymbol,
    getAll,
    getSummary,
  };
}
