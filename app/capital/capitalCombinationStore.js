/**
 * Capital Combination SQLite Store — Phase 4D
 *
 * PASSIVE / ADDITIVE / IDEMPOTENT
 * ─────────────────────────────────────────────────────────────────
 * Opens the existing wheelValidationJournal.sqlite file and adds 4
 * new tables IF they don't already exist.  All migrations use
 * CREATE TABLE IF NOT EXISTS — zero risk to existing data.
 *
 * Absolute prohibitions enforced here:
 *   ✗ No DROP TABLE
 *   ✗ No RENAME TABLE
 *   ✗ No DELETE on existing tables
 *   ✗ No scanner / IBKR / Yahoo hook
 *   ✓ Only INSERT on the 4 new capital_combination_* tables
 */

import path from "node:path";
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

// ─── Helpers (mirrors pattern in wheelValidationStoreSqlite.js) ───────────────

function safeExec(conn, sql) {
  try {
    conn.exec(sql);
  } catch (_) {
    // Idempotent: silently ignore "already exists" and similar
  }
}

function toReal(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toInt(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createCapitalCombinationStore(options = {}) {
  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
  let db = null;
  let initialized = false;

  function getConn() {
    if (!db) db = new DatabaseSync(sqlitePath);
    return db;
  }

  // ── ensureInitialized ──────────────────────────────────────────────────────
  // Creates the 4 capital combination tables if absent.
  // Called once at startup; subsequent calls are no-ops.

  async function ensureInitialized() {
    if (initialized) return;
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    const conn = getConn();

    // Phase 4D — Table 1: top-level scan snapshot
    safeExec(conn, `
      CREATE TABLE IF NOT EXISTS capital_combination_snapshots (
        id                 TEXT PRIMARY KEY,
        scan_session_id    TEXT,
        scan_timestamp     TEXT,
        scan_date          TEXT,
        selected_expiration TEXT,
        account_capital    REAL,
        source             TEXT,
        created_at         TEXT
      )
    `);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccs_scan_date    ON capital_combination_snapshots(scan_date)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccs_scan_session ON capital_combination_snapshots(scan_session_id)`);

    // Phase 4D — Table 2: per-mode aggregate row
    safeExec(conn, `
      CREATE TABLE IF NOT EXISTS capital_combination_modes (
        id                        TEXT PRIMARY KEY,
        snapshot_id               TEXT NOT NULL,
        mode                      TEXT NOT NULL,
        position_count            INTEGER,
        capital_used              REAL,
        capital_free              REAL,
        capital_utilization_pct   REAL,
        total_premium             REAL,
        avg_yield_pct             REAL,
        estimated_return_pct      REAL,
        concentration_score       REAL,
        diversification_score     REAL,
        risk_score                REAL,
        quality_score             REAL,
        audit_status              TEXT,
        audit_warnings_json       TEXT,
        created_at                TEXT
      )
    `);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccm_snapshot_id ON capital_combination_modes(snapshot_id)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccm_mode        ON capital_combination_modes(mode)`);

    // Phase 4D-3B — additive POP columns (idempotent via safeExec)
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN pop_avg REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN pop_weighted_by_capital REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN pop_min REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN pop_below_80_count INTEGER`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN pop_below_85_count INTEGER`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN yield_per_pop_risk REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN risk_adjusted_pop_score REAL`);

    // Phase 4D-3B — guard for pop_estimate on positions (idempotent if already present)
    safeExec(conn, `ALTER TABLE capital_combination_positions ADD COLUMN pop_estimate REAL`);

    // Phase 4D-3C — quality overlay columns for modes (idempotent)
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN avg_quality_score REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN avoid_count INTEGER`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN speculative_count INTEGER`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN premium_trap_count INTEGER`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN crypto_miner_count INTEGER`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN high_beta_growth_count INTEGER`);

    // Phase 4D-3C — quality overlay columns for positions (idempotent)
    safeExec(conn, `ALTER TABLE capital_combination_positions ADD COLUMN quality_tier TEXT`);
    safeExec(conn, `ALTER TABLE capital_combination_positions ADD COLUMN quality_score REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_positions ADD COLUMN speculative_penalty REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_positions ADD COLUMN premium_trap_penalty REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_positions ADD COLUMN concentration_theme TEXT`);
    safeExec(conn, `ALTER TABLE capital_combination_positions ADD COLUMN quality_warnings_json TEXT`);

    // Phase 4D-4 — concentration metrics per mode (idempotent)
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN crypto_miner_capital_pct REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN high_beta_capital_pct REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN largest_theme_capital_pct REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN largest_ticker_capital_pct REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN concentration_risk_score REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN diversification_health_score REAL`);
    safeExec(conn, `ALTER TABLE capital_combination_modes ADD COLUMN cluster_warnings_json TEXT`);

    // Phase 4D — Table 3: individual position rows
    safeExec(conn, `
      CREATE TABLE IF NOT EXISTS capital_combination_positions (
        id               TEXT PRIMARY KEY,
        snapshot_id      TEXT NOT NULL,
        mode_id          TEXT,
        mode             TEXT,
        ticker           TEXT,
        strike           REAL,
        expiration       TEXT,
        contracts        INTEGER,
        capital_required REAL,
        premium_unit     REAL,
        total_premium    REAL,
        yield_pct        REAL,
        source           TEXT,
        strike_mode      TEXT,
        ibkr_validated   INTEGER,
        yahoo_validated  INTEGER,
        elite_score      REAL,
        pop_estimate     REAL,
        spread_pct       REAL,
        open_interest    INTEGER,
        volume           INTEGER,
        sector           TEXT,
        risk_tags_json   TEXT,
        created_at       TEXT
      )
    `);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccp_snapshot_id ON capital_combination_positions(snapshot_id)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccp_ticker      ON capital_combination_positions(ticker)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccp_mode        ON capital_combination_positions(mode)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_ccp_mode_id     ON capital_combination_positions(mode_id)`);

    // Phase 4D — Table 4: outcome tracking (populated post-expiration)
    safeExec(conn, `
      CREATE TABLE IF NOT EXISTS capital_combination_outcomes (
        id                    TEXT PRIMARY KEY,
        snapshot_id           TEXT NOT NULL,
        mode_id               TEXT,
        position_id           TEXT,
        ticker                TEXT,
        mode                  TEXT,
        expiration            TEXT,
        resolved              INTEGER DEFAULT 0,
        expired_otm           INTEGER,
        assigned_flag         INTEGER,
        strike_touched        INTEGER,
        broke_lower_bound     INTEGER,
        max_itm_depth_pct     REAL,
        realized_premium      REAL,
        realized_pl           REAL,
        realized_return_pct   REAL,
        stress_score          REAL,
        outcome_quality_score REAL,
        resolved_at           TEXT,
        created_at            TEXT
      )
    `);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_cco_snapshot_id ON capital_combination_outcomes(snapshot_id)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_cco_ticker      ON capital_combination_outcomes(ticker)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_cco_mode        ON capital_combination_outcomes(mode)`);
    safeExec(conn, `CREATE INDEX IF NOT EXISTS idx_cco_resolved    ON capital_combination_outcomes(resolved)`);

    initialized = true;
  }

  // ── saveSnapshot ───────────────────────────────────────────────────────────
  // Persists one full combination audit snapshot.
  // payload  : raw incoming request body
  // audit    : result from auditCapitalCombination()

  async function saveSnapshot(payload, audit) {
    await ensureInitialized();
    const conn = getConn();
    const now = new Date().toISOString();
    const scanDate = now.slice(0, 10);
    const snapshotId = randomUUID();

    conn.prepare(`
      INSERT INTO capital_combination_snapshots
        (id, scan_session_id, scan_timestamp, scan_date, selected_expiration, account_capital, source, created_at)
      VALUES
        (@id, @scan_session_id, @scan_timestamp, @scan_date, @selected_expiration, @account_capital, @source, @created_at)
    `).run({
      id: snapshotId,
      scan_session_id: toText(payload?.scanSessionId ?? payload?.scan_session_id),
      scan_timestamp: now,
      scan_date: scanDate,
      selected_expiration: toText(payload?.selectedExpiration ?? payload?.expiration),
      account_capital: toReal(audit?.accountCapital ?? payload?.accountCapital ?? payload?.account_capital),
      source: toText(payload?.source ?? "manual"),
      created_at: now,
    });

    const modeIds = {};
    const modeOrder = ["conservative", "balanced", "aggressive"];

    for (const modeKey of modeOrder) {
      const modeMetrics = audit?.modes?.[modeKey];
      if (!modeMetrics) continue;

      const modeId = randomUUID();
      modeIds[modeKey] = modeId;

      const modeWarnings = [
        ...(modeMetrics.warnings ?? []),
        ...(modeMetrics.positionWarnings ?? []),
      ];

      conn.prepare(`
        INSERT INTO capital_combination_modes
          (id, snapshot_id, mode, position_count, capital_used, capital_free, capital_utilization_pct,
           total_premium, avg_yield_pct, estimated_return_pct, concentration_score, diversification_score,
           risk_score, quality_score, audit_status, audit_warnings_json,
           pop_avg, pop_weighted_by_capital, pop_min, pop_below_80_count, pop_below_85_count,
           yield_per_pop_risk, risk_adjusted_pop_score,
           avg_quality_score, avoid_count, speculative_count, premium_trap_count,
           crypto_miner_count, high_beta_growth_count,
           crypto_miner_capital_pct, high_beta_capital_pct, largest_theme_capital_pct,
           largest_ticker_capital_pct, concentration_risk_score, diversification_health_score,
           cluster_warnings_json,
           created_at)
        VALUES
          (@id, @snapshot_id, @mode, @position_count, @capital_used, @capital_free, @capital_utilization_pct,
           @total_premium, @avg_yield_pct, @estimated_return_pct, @concentration_score, @diversification_score,
           @risk_score, @quality_score, @audit_status, @audit_warnings_json,
           @pop_avg, @pop_weighted_by_capital, @pop_min, @pop_below_80_count, @pop_below_85_count,
           @yield_per_pop_risk, @risk_adjusted_pop_score,
           @avg_quality_score, @avoid_count, @speculative_count, @premium_trap_count,
           @crypto_miner_count, @high_beta_growth_count,
           @crypto_miner_capital_pct, @high_beta_capital_pct, @largest_theme_capital_pct,
           @largest_ticker_capital_pct, @concentration_risk_score, @diversification_health_score,
           @cluster_warnings_json,
           @created_at)
      `).run({
        id: modeId,
        snapshot_id: snapshotId,
        mode: modeKey,
        position_count: toInt(modeMetrics.positionCount),
        capital_used: toReal(modeMetrics.capitalUsed),
        capital_free: toReal(modeMetrics.capitalFree),
        capital_utilization_pct: toReal(modeMetrics.capitalUtilizationPct),
        total_premium: toReal(modeMetrics.totalPremium),
        avg_yield_pct: toReal(modeMetrics.avgYieldPct),
        estimated_return_pct: toReal(modeMetrics.estimatedReturnPct),
        concentration_score: toReal(modeMetrics.concentrationScore),
        diversification_score: toReal(modeMetrics.diversificationScore),
        risk_score: toReal(modeMetrics.riskScore),
        quality_score: toReal(modeMetrics.qualityScore),
        audit_status: modeWarnings.length === 0 ? "ok" : "warnings",
        audit_warnings_json: JSON.stringify(modeWarnings),
        pop_avg: toReal(modeMetrics.popAvg),
        pop_weighted_by_capital: toReal(modeMetrics.popWeightedByCapital),
        pop_min: toReal(modeMetrics.popMin),
        pop_below_80_count: toInt(modeMetrics.popBelow80Count),
        pop_below_85_count: toInt(modeMetrics.popBelow85Count),
        yield_per_pop_risk: toReal(modeMetrics.yieldPerPopRisk),
        risk_adjusted_pop_score: toReal(modeMetrics.riskAdjustedPopScore),
        avg_quality_score: toReal(modeMetrics.avgQualityScore),
        avoid_count: toInt(modeMetrics.avoidCount),
        speculative_count: toInt(modeMetrics.speculativeCount),
        premium_trap_count: toInt(modeMetrics.premiumTrapCount),
        crypto_miner_count: toInt(modeMetrics.cryptoMinerCount),
        high_beta_growth_count: toInt(modeMetrics.highBetaGrowthCount),
        crypto_miner_capital_pct: toReal(modeMetrics.cryptoMinerCapitalPct),
        high_beta_capital_pct: toReal(modeMetrics.highBetaCapitalPct),
        largest_theme_capital_pct: toReal(modeMetrics.largestThemeCapitalPct),
        largest_ticker_capital_pct: toReal(modeMetrics.largestTickerCapitalPct),
        concentration_risk_score: toReal(modeMetrics.concentrationRiskScore),
        diversification_health_score: toReal(modeMetrics.diversificationHealthScore),
        cluster_warnings_json: Array.isArray(modeMetrics.clusterWarnings) && modeMetrics.clusterWarnings.length > 0
          ? JSON.stringify(modeMetrics.clusterWarnings) : null,
        created_at: now,
      });

      // Insert positions
      const positionMetrics = modeMetrics.positionMetrics ?? [];
      const rawPositions = getRawPositions(payload, modeKey);

      for (let i = 0; i < positionMetrics.length; i++) {
        const pm = positionMetrics[i];
        const raw = rawPositions[i] ?? {};
        const posId = randomUUID();

        conn.prepare(`
          INSERT INTO capital_combination_positions
            (id, snapshot_id, mode_id, mode, ticker, strike, expiration, contracts, capital_required,
             premium_unit, total_premium, yield_pct, source, strike_mode, ibkr_validated, yahoo_validated,
             elite_score, pop_estimate, spread_pct, open_interest, volume, sector, risk_tags_json,
             quality_tier, quality_score, speculative_penalty, premium_trap_penalty,
             concentration_theme, quality_warnings_json,
             created_at)
          VALUES
            (@id, @snapshot_id, @mode_id, @mode, @ticker, @strike, @expiration, @contracts, @capital_required,
             @premium_unit, @total_premium, @yield_pct, @source, @strike_mode, @ibkr_validated, @yahoo_validated,
             @elite_score, @pop_estimate, @spread_pct, @open_interest, @volume, @sector, @risk_tags_json,
             @quality_tier, @quality_score, @speculative_penalty, @premium_trap_penalty,
             @concentration_theme, @quality_warnings_json,
             @created_at)
        `).run({
          id: posId,
          snapshot_id: snapshotId,
          mode_id: modeId,
          mode: modeKey,
          ticker: toText(pm.ticker),
          strike: toReal(pm.strike),
          expiration: toText(raw?.expiration),
          contracts: toInt(pm.contracts),
          capital_required: toReal(pm.capitalUsed),
          premium_unit: toReal(pm.premiumUnit),
          total_premium: toReal(pm.premiumCollected),
          yield_pct: toReal(pm.weeklyReturn),
          source: toText(raw?.source ?? raw?.premiumKind),
          strike_mode: toText(raw?.strikeMode ?? raw?.strike_mode),
          ibkr_validated: raw?.ibkrValidated != null ? (raw.ibkrValidated ? 1 : 0) : null,
          yahoo_validated: raw?.yahooValidated != null ? (raw.yahooValidated ? 1 : 0) : null,
          elite_score: toReal(raw?.eliteScore ?? raw?.elite_score),
          pop_estimate: toReal(pm.popEstimate ?? raw?.popEstimate ?? raw?.pop_estimate),
          spread_pct: toReal(raw?.spreadPct ?? raw?.spread_pct),
          open_interest: toInt(raw?.openInterest ?? raw?.open_interest),
          volume: toInt(raw?.volume),
          sector: toText(raw?.sector),
          risk_tags_json: raw?.riskTags ? JSON.stringify(raw.riskTags) : null,
          quality_tier: toText(pm.qualityTier ?? raw?.qualityTier),
          quality_score: toReal(pm.qualityScore ?? raw?.qualityScore),
          speculative_penalty: toReal(pm.speculativePenalty ?? raw?.speculativePenalty),
          premium_trap_penalty: toReal(pm.premiumTrapPenalty ?? raw?.premiumTrapPenalty),
          concentration_theme: toText(pm.concentrationTheme ?? raw?.concentrationTheme),
          quality_warnings_json: (() => {
            const warnings = pm.qualityWarnings?.length
              ? pm.qualityWarnings
              : raw?.qualityWarnings ?? null;
            return warnings ? JSON.stringify(warnings) : null;
          })(),
          created_at: now,
        });
      }
    }

    return { snapshotId, modeIds };
  }

  // ── getRawPositions ────────────────────────────────────────────────────────
  // Extracts the raw positions array from the original payload for a given mode.

  function getRawPositions(payload, modeKey) {
    const aliases = {
      conservative: ["conservative", "conservateur", "conservatif"],
      balanced: ["balanced", "equilibre", "équilibré", "equilbre"],
      aggressive: ["aggressive", "agressif"],
    };
    for (const alias of aliases[modeKey] ?? []) {
      const modeData = payload?.[alias];
      if (modeData) {
        const arr = modeData?.picks ?? modeData?.positions;
        if (Array.isArray(arr)) return arr;
      }
    }
    return [];
  }

  // ── getHistory ─────────────────────────────────────────────────────────────

  async function getHistory(limit = 50) {
    await ensureInitialized();
    const conn = getConn();
    return conn.prepare(`
      SELECT
        s.id,
        s.scan_date,
        s.scan_timestamp,
        s.selected_expiration,
        s.account_capital,
        s.source,
        COUNT(DISTINCT m.id)  AS mode_count,
        COUNT(DISTINCT p.id)  AS position_count
      FROM capital_combination_snapshots s
      LEFT JOIN capital_combination_modes     m ON m.snapshot_id = s.id
      LEFT JOIN capital_combination_positions p ON p.snapshot_id = s.id
      GROUP BY s.id
      ORDER BY s.scan_timestamp DESC
      LIMIT @limit
    `).all({ limit: Math.min(200, Math.max(1, Number(limit))) });
  }

  // ── getStats ───────────────────────────────────────────────────────────────

  async function getStats() {
    await ensureInitialized();
    const conn = getConn();

    const totalRow = conn
      .prepare("SELECT COUNT(*) AS count FROM capital_combination_snapshots")
      .get();

    const modeStats = conn.prepare(`
      SELECT
        mode,
        COUNT(*)                          AS sample_count,
        AVG(avg_yield_pct)                AS avg_yield_pct,
        AVG(capital_utilization_pct)      AS avg_capital_utilization_pct,
        AVG(total_premium)                AS avg_total_premium,
        AVG(risk_score)                   AS avg_risk_score,
        AVG(quality_score)                AS avg_quality_score,
        AVG(concentration_score)          AS avg_concentration_score,
        AVG(diversification_score)        AS avg_diversification_score,
        AVG(pop_weighted_by_capital)      AS avg_pop_weighted_by_capital,
        AVG(pop_min)                      AS avg_pop_min,
        AVG(risk_adjusted_pop_score)      AS avg_risk_adjusted_pop_score,
        AVG(yield_per_pop_risk)           AS avg_yield_per_pop_risk
      FROM capital_combination_modes
      GROUP BY mode
    `).all();

    const outcomeStats = conn.prepare(`
      SELECT
        mode,
        COUNT(*)                                               AS total,
        SUM(CASE WHEN resolved = 1 THEN 1 ELSE 0 END)         AS resolved,
        AVG(CASE WHEN resolved = 1 THEN realized_return_pct END) AS avg_realized_return_pct,
        SUM(CASE WHEN assigned_flag = 1 THEN 1 ELSE 0 END)    AS assigned_count,
        SUM(CASE WHEN strike_touched = 1 THEN 1 ELSE 0 END)   AS strike_touched_count,
        AVG(stress_score)                                      AS avg_stress_score
      FROM capital_combination_outcomes
      GROUP BY mode
    `).all();

    return {
      totalSnapshots: totalRow?.count ?? 0,
      modeStats,
      outcomeStats,
    };
  }

  // ── getTablesReady ─────────────────────────────────────────────────────────

  async function getTablesReady() {
    try {
      await ensureInitialized();
      return true;
    } catch (_) {
      return false;
    }
  }

  return {
    ensureInitialized,
    saveSnapshot,
    getHistory,
    getStats,
    getTablesReady,
  };
}
