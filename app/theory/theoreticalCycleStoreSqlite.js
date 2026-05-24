import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const DEFAULT_SQLITE_PATH = path.resolve(process.cwd(), "data", "wheelValidationJournal.sqlite");

function toInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function toReal(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toIntBool(value) {
  if (value === true) return 1;
  if (value === false) return 0;
  if (value === 1) return 1;
  if (value === 0) return 0;
  return null;
}

function safeExec(conn, sql) {
  try {
    conn.exec(sql);
  } catch (_) {
    // Idempotent: ignore errors (e.g. column already exists)
  }
}

export function createTheoreticalCycleStoreSqlite(options = {}) {
  const sqlitePath = options.sqlitePath ?? DEFAULT_SQLITE_PATH;
  let db = null;
  let initialized = false;

  function ensureDbSync() {
    if (db) return db;
    db = new DatabaseSync(sqlitePath);
    return db;
  }

  async function ensureInitialized() {
    if (initialized) return;
    await fs.mkdir(path.dirname(sqlitePath), { recursive: true });
    const conn = ensureDbSync();

    conn.exec(`
      CREATE TABLE IF NOT EXISTS theoretical_wheel_cycles (
        id TEXT PRIMARY KEY,
        candidate_record_id TEXT NOT NULL,
        trade_signature TEXT,
        scan_session_id TEXT,
        scan_timestamp TEXT,
        scan_date TEXT,
        ticker TEXT NOT NULL,
        expiration TEXT,
        assignment_date TEXT,
        assignment_strike REAL NOT NULL,
        assignment_price REAL,
        spot_at_scan REAL,
        spot_at_assignment REAL,
        strike_mode TEXT,
        csp_strike REAL,
        csp_premium REAL,
        csp_yield_pct REAL,
        pop_estimate REAL,
        distance_strike_from_spot_pct REAL,
        status TEXT NOT NULL DEFAULT 'open',
        current_step INTEGER DEFAULT 0,
        days_to_strike_touch INTEGER,
        days_to_strike_close_above INTEGER,
        days_below_assignment_strike INTEGER,
        max_drawdown_pct REAL,
        total_cc_premium_estimated REAL DEFAULT 0,
        total_cc_premium_conservative REAL DEFAULT 0,
        total_premium_estimated REAL DEFAULT 0,
        reduced_cost_basis_estimated REAL,
        cc_sellable_steps_count INTEGER DEFAULT 0,
        cc_wait_steps_count INTEGER DEFAULT 0,
        best_cc_threshold_reached REAL,
        source_prime_method TEXT,
        confidence_level TEXT,
        data_quality TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(candidate_record_id)
      );
      CREATE INDEX IF NOT EXISTS idx_twc_ticker ON theoretical_wheel_cycles(ticker);
      CREATE INDEX IF NOT EXISTS idx_twc_status ON theoretical_wheel_cycles(status);
      CREATE INDEX IF NOT EXISTS idx_twc_assignment_date ON theoretical_wheel_cycles(assignment_date);
      CREATE INDEX IF NOT EXISTS idx_twc_strike_mode ON theoretical_wheel_cycles(strike_mode);
      CREATE INDEX IF NOT EXISTS idx_twc_trade_signature ON theoretical_wheel_cycles(trade_signature);
    `);

    conn.exec(`
      CREATE TABLE IF NOT EXISTS theoretical_cc_steps (
        id TEXT PRIMARY KEY,
        theoretical_cycle_id TEXT NOT NULL,
        candidate_record_id TEXT,
        ticker TEXT NOT NULL,
        sequence_number INTEGER NOT NULL,
        test_date TEXT NOT NULL,
        target_time TEXT,
        cc_expiration TEXT,
        dte INTEGER,
        stock_price_used REAL,
        stock_open REAL,
        stock_high REAL,
        stock_low REAL,
        stock_close REAL,
        assignment_strike REAL,
        cc_strike REAL NOT NULL,
        volatility_used REAL,
        volatility_source TEXT,
        risk_free_rate REAL,
        dividend_yield REAL,
        bs_call_premium REAL,
        premium_estimated REAL,
        premium_conservative REAL,
        conservative_factor REAL,
        cc_yield_pct REAL,
        cc_yield_conservative_pct REAL,
        cc_sold_theoretical INTEGER DEFAULT 0,
        not_sold_reason TEXT,
        best_threshold_reached REAL,
        threshold_0_5_hit INTEGER,
        threshold_0_75_hit INTEGER,
        threshold_1_0_hit INTEGER,
        threshold_1_5_hit INTEGER,
        threshold_2_0_hit INTEGER,
        threshold_2_5_hit INTEGER,
        threshold_3_0_hit INTEGER,
        threshold_4_0_hit INTEGER,
        threshold_5_0_hit INTEGER,
        threshold_6_0_hit INTEGER,
        opportunity_intraday_detected INTEGER DEFAULT 0,
        intraday_best_threshold_reached REAL,
        result_at_expiration TEXT,
        called_away_theoretical INTEGER,
        expired_otm INTEGER,
        data_quality TEXT,
        raw_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(theoretical_cycle_id, sequence_number)
      );
      CREATE INDEX IF NOT EXISTS idx_tcs_cycle_id ON theoretical_cc_steps(theoretical_cycle_id);
      CREATE INDEX IF NOT EXISTS idx_tcs_ticker ON theoretical_cc_steps(ticker);
      CREATE INDEX IF NOT EXISTS idx_tcs_test_date ON theoretical_cc_steps(test_date);
      CREATE INDEX IF NOT EXISTS idx_tcs_cc_expiration ON theoretical_cc_steps(cc_expiration);
      CREATE INDEX IF NOT EXISTS idx_tcs_cc_sold ON theoretical_cc_steps(cc_sold_theoretical);
    `);

    // Additive migrations — idempotent, safe for future columns
    safeExec(conn, `ALTER TABLE theoretical_wheel_cycles ADD COLUMN source_prime_method TEXT`);
    safeExec(conn, `ALTER TABLE theoretical_wheel_cycles ADD COLUMN assignment_recovery_date TEXT`);
    safeExec(conn, `ALTER TABLE theoretical_wheel_cycles ADD COLUMN assignment_recovered INTEGER`);
    safeExec(conn, `ALTER TABLE theoretical_cc_steps ADD COLUMN intraday_best_threshold_reached REAL`);

    initialized = true;
  }

  async function upsertCycle(cycle) {
    await ensureInitialized();
    const conn = ensureDbSync();
    if (!cycle?.id) throw new Error("upsertCycle: id is required");
    if (!cycle?.candidate_record_id) throw new Error("upsertCycle: candidate_record_id is required");
    if (!cycle?.ticker) throw new Error("upsertCycle: ticker is required");
    if (cycle?.assignment_strike == null) throw new Error("upsertCycle: assignment_strike is required");
    const nowIso = new Date().toISOString();
    const stmt = conn.prepare(`
      INSERT INTO theoretical_wheel_cycles (
        id, candidate_record_id, trade_signature, scan_session_id, scan_timestamp, scan_date,
        ticker, expiration, assignment_date, assignment_strike, assignment_price,
        spot_at_scan, spot_at_assignment,
        strike_mode, csp_strike, csp_premium, csp_yield_pct, pop_estimate, distance_strike_from_spot_pct,
        status, current_step,
        days_to_strike_touch, days_to_strike_close_above, days_below_assignment_strike, max_drawdown_pct,
        total_cc_premium_estimated, total_cc_premium_conservative, total_premium_estimated,
        reduced_cost_basis_estimated, cc_sellable_steps_count, cc_wait_steps_count, best_cc_threshold_reached,
        assignment_recovery_date, assignment_recovered,
        source_prime_method, confidence_level, data_quality, raw_json,
        created_at, updated_at
      ) VALUES (
        @id, @candidate_record_id, @trade_signature, @scan_session_id, @scan_timestamp, @scan_date,
        @ticker, @expiration, @assignment_date, @assignment_strike, @assignment_price,
        @spot_at_scan, @spot_at_assignment,
        @strike_mode, @csp_strike, @csp_premium, @csp_yield_pct, @pop_estimate, @distance_strike_from_spot_pct,
        @status, @current_step,
        @days_to_strike_touch, @days_to_strike_close_above, @days_below_assignment_strike, @max_drawdown_pct,
        @total_cc_premium_estimated, @total_cc_premium_conservative, @total_premium_estimated,
        @reduced_cost_basis_estimated, @cc_sellable_steps_count, @cc_wait_steps_count, @best_cc_threshold_reached,
        @assignment_recovery_date, @assignment_recovered,
        @source_prime_method, @confidence_level, @data_quality, @raw_json,
        @created_at, @updated_at
      ) ON CONFLICT(id) DO UPDATE SET
        candidate_record_id=excluded.candidate_record_id,
        trade_signature=excluded.trade_signature,
        scan_session_id=excluded.scan_session_id,
        scan_timestamp=excluded.scan_timestamp,
        scan_date=excluded.scan_date,
        ticker=excluded.ticker,
        expiration=excluded.expiration,
        assignment_date=excluded.assignment_date,
        assignment_strike=excluded.assignment_strike,
        assignment_price=excluded.assignment_price,
        spot_at_scan=excluded.spot_at_scan,
        spot_at_assignment=excluded.spot_at_assignment,
        strike_mode=excluded.strike_mode,
        csp_strike=excluded.csp_strike,
        csp_premium=excluded.csp_premium,
        csp_yield_pct=excluded.csp_yield_pct,
        pop_estimate=excluded.pop_estimate,
        distance_strike_from_spot_pct=excluded.distance_strike_from_spot_pct,
        status=excluded.status,
        current_step=excluded.current_step,
        days_to_strike_touch=excluded.days_to_strike_touch,
        days_to_strike_close_above=excluded.days_to_strike_close_above,
        days_below_assignment_strike=excluded.days_below_assignment_strike,
        max_drawdown_pct=excluded.max_drawdown_pct,
        total_cc_premium_estimated=excluded.total_cc_premium_estimated,
        total_cc_premium_conservative=excluded.total_cc_premium_conservative,
        total_premium_estimated=excluded.total_premium_estimated,
        reduced_cost_basis_estimated=excluded.reduced_cost_basis_estimated,
        cc_sellable_steps_count=excluded.cc_sellable_steps_count,
        cc_wait_steps_count=excluded.cc_wait_steps_count,
        best_cc_threshold_reached=excluded.best_cc_threshold_reached,
        assignment_recovery_date=excluded.assignment_recovery_date,
        assignment_recovered=excluded.assignment_recovered,
        source_prime_method=excluded.source_prime_method,
        confidence_level=excluded.confidence_level,
        data_quality=excluded.data_quality,
        raw_json=excluded.raw_json,
        created_at=COALESCE(theoretical_wheel_cycles.created_at, excluded.created_at),
        updated_at=excluded.updated_at
    `);
    return stmt.run({
      id: String(cycle.id),
      candidate_record_id: String(cycle.candidate_record_id),
      trade_signature: cycle.trade_signature ?? null,
      scan_session_id: cycle.scan_session_id ?? null,
      scan_timestamp: cycle.scan_timestamp ?? null,
      scan_date: cycle.scan_date ?? null,
      ticker: String(cycle.ticker),
      expiration: cycle.expiration ?? null,
      assignment_date: cycle.assignment_date ?? null,
      assignment_strike: toReal(cycle.assignment_strike),
      assignment_price: toReal(cycle.assignment_price),
      spot_at_scan: toReal(cycle.spot_at_scan),
      spot_at_assignment: toReal(cycle.spot_at_assignment),
      strike_mode: cycle.strike_mode ?? null,
      csp_strike: toReal(cycle.csp_strike),
      csp_premium: toReal(cycle.csp_premium),
      csp_yield_pct: toReal(cycle.csp_yield_pct),
      pop_estimate: toReal(cycle.pop_estimate),
      distance_strike_from_spot_pct: toReal(cycle.distance_strike_from_spot_pct),
      status: cycle.status ?? "open",
      current_step: toInt(cycle.current_step) ?? 0,
      days_to_strike_touch: toInt(cycle.days_to_strike_touch),
      days_to_strike_close_above: toInt(cycle.days_to_strike_close_above),
      days_below_assignment_strike: toInt(cycle.days_below_assignment_strike),
      max_drawdown_pct: toReal(cycle.max_drawdown_pct),
      total_cc_premium_estimated: toReal(cycle.total_cc_premium_estimated) ?? 0,
      total_cc_premium_conservative: toReal(cycle.total_cc_premium_conservative) ?? 0,
      total_premium_estimated: toReal(cycle.total_premium_estimated) ?? 0,
      reduced_cost_basis_estimated: toReal(cycle.reduced_cost_basis_estimated),
      cc_sellable_steps_count: toInt(cycle.cc_sellable_steps_count) ?? 0,
      cc_wait_steps_count: toInt(cycle.cc_wait_steps_count) ?? 0,
      best_cc_threshold_reached: toReal(cycle.best_cc_threshold_reached),
      assignment_recovery_date: cycle.assignment_recovery_date ?? null,
      assignment_recovered: toIntBool(cycle.assignment_recovered),
      source_prime_method: cycle.source_prime_method ?? null,
      confidence_level: cycle.confidence_level ?? null,
      data_quality: cycle.data_quality ?? null,
      raw_json: JSON.stringify(cycle.raw ?? cycle),
      created_at: cycle.created_at ?? nowIso,
      updated_at: nowIso,
    });
  }

  async function getCycleById(id) {
    await ensureInitialized();
    const conn = ensureDbSync();
    const row = conn.prepare("SELECT * FROM theoretical_wheel_cycles WHERE id = @id").get({ id: String(id) });
    return row ?? null;
  }

  async function listCycles(limit = 100) {
    await ensureInitialized();
    const conn = ensureDbSync();
    return conn
      .prepare("SELECT * FROM theoretical_wheel_cycles ORDER BY created_at DESC LIMIT @limit")
      .all({ limit: toInt(limit) ?? 100 });
  }

  async function listCyclesByTicker(symbol, limit = 100) {
    await ensureInitialized();
    const conn = ensureDbSync();
    return conn
      .prepare("SELECT * FROM theoretical_wheel_cycles WHERE ticker = @ticker ORDER BY created_at DESC LIMIT @limit")
      .all({ ticker: String(symbol), limit: toInt(limit) ?? 100 });
  }

  async function upsertCcStep(step) {
    await ensureInitialized();
    const conn = ensureDbSync();
    if (!step?.id) throw new Error("upsertCcStep: id is required");
    if (!step?.theoretical_cycle_id) throw new Error("upsertCcStep: theoretical_cycle_id is required");
    if (step?.sequence_number == null) throw new Error("upsertCcStep: sequence_number is required");
    if (!step?.ticker) throw new Error("upsertCcStep: ticker is required");
    if (step?.cc_strike == null) throw new Error("upsertCcStep: cc_strike is required");
    const nowIso = new Date().toISOString();
    const stmt = conn.prepare(`
      INSERT INTO theoretical_cc_steps (
        id, theoretical_cycle_id, candidate_record_id, ticker,
        sequence_number, test_date, target_time, cc_expiration, dte,
        stock_price_used, stock_open, stock_high, stock_low, stock_close,
        assignment_strike, cc_strike,
        volatility_used, volatility_source, risk_free_rate, dividend_yield,
        bs_call_premium, premium_estimated, premium_conservative, conservative_factor,
        cc_yield_pct, cc_yield_conservative_pct,
        cc_sold_theoretical, not_sold_reason, best_threshold_reached,
        threshold_0_5_hit, threshold_0_75_hit, threshold_1_0_hit,
        threshold_1_5_hit, threshold_2_0_hit, threshold_2_5_hit, threshold_3_0_hit,
        threshold_4_0_hit, threshold_5_0_hit, threshold_6_0_hit,
        opportunity_intraday_detected, intraday_best_threshold_reached,
        result_at_expiration, called_away_theoretical, expired_otm,
        data_quality, raw_json, created_at, updated_at
      ) VALUES (
        @id, @theoretical_cycle_id, @candidate_record_id, @ticker,
        @sequence_number, @test_date, @target_time, @cc_expiration, @dte,
        @stock_price_used, @stock_open, @stock_high, @stock_low, @stock_close,
        @assignment_strike, @cc_strike,
        @volatility_used, @volatility_source, @risk_free_rate, @dividend_yield,
        @bs_call_premium, @premium_estimated, @premium_conservative, @conservative_factor,
        @cc_yield_pct, @cc_yield_conservative_pct,
        @cc_sold_theoretical, @not_sold_reason, @best_threshold_reached,
        @threshold_0_5_hit, @threshold_0_75_hit, @threshold_1_0_hit,
        @threshold_1_5_hit, @threshold_2_0_hit, @threshold_2_5_hit, @threshold_3_0_hit,
        @threshold_4_0_hit, @threshold_5_0_hit, @threshold_6_0_hit,
        @opportunity_intraday_detected, @intraday_best_threshold_reached,
        @result_at_expiration, @called_away_theoretical, @expired_otm,
        @data_quality, @raw_json, @created_at, @updated_at
      ) ON CONFLICT(id) DO UPDATE SET
        theoretical_cycle_id=excluded.theoretical_cycle_id,
        candidate_record_id=excluded.candidate_record_id,
        ticker=excluded.ticker,
        sequence_number=excluded.sequence_number,
        test_date=excluded.test_date,
        target_time=excluded.target_time,
        cc_expiration=excluded.cc_expiration,
        dte=excluded.dte,
        stock_price_used=excluded.stock_price_used,
        stock_open=excluded.stock_open,
        stock_high=excluded.stock_high,
        stock_low=excluded.stock_low,
        stock_close=excluded.stock_close,
        assignment_strike=excluded.assignment_strike,
        cc_strike=excluded.cc_strike,
        volatility_used=excluded.volatility_used,
        volatility_source=excluded.volatility_source,
        risk_free_rate=excluded.risk_free_rate,
        dividend_yield=excluded.dividend_yield,
        bs_call_premium=excluded.bs_call_premium,
        premium_estimated=excluded.premium_estimated,
        premium_conservative=excluded.premium_conservative,
        conservative_factor=excluded.conservative_factor,
        cc_yield_pct=excluded.cc_yield_pct,
        cc_yield_conservative_pct=excluded.cc_yield_conservative_pct,
        cc_sold_theoretical=excluded.cc_sold_theoretical,
        not_sold_reason=excluded.not_sold_reason,
        best_threshold_reached=excluded.best_threshold_reached,
        threshold_0_5_hit=excluded.threshold_0_5_hit,
        threshold_0_75_hit=excluded.threshold_0_75_hit,
        threshold_1_0_hit=excluded.threshold_1_0_hit,
        threshold_1_5_hit=excluded.threshold_1_5_hit,
        threshold_2_0_hit=excluded.threshold_2_0_hit,
        threshold_2_5_hit=excluded.threshold_2_5_hit,
        threshold_3_0_hit=excluded.threshold_3_0_hit,
        threshold_4_0_hit=excluded.threshold_4_0_hit,
        threshold_5_0_hit=excluded.threshold_5_0_hit,
        threshold_6_0_hit=excluded.threshold_6_0_hit,
        opportunity_intraday_detected=excluded.opportunity_intraday_detected,
        intraday_best_threshold_reached=excluded.intraday_best_threshold_reached,
        result_at_expiration=excluded.result_at_expiration,
        called_away_theoretical=excluded.called_away_theoretical,
        expired_otm=excluded.expired_otm,
        data_quality=excluded.data_quality,
        raw_json=excluded.raw_json,
        created_at=COALESCE(theoretical_cc_steps.created_at, excluded.created_at),
        updated_at=excluded.updated_at
    `);
    return stmt.run({
      id: String(step.id),
      theoretical_cycle_id: String(step.theoretical_cycle_id),
      candidate_record_id: step.candidate_record_id ?? null,
      ticker: String(step.ticker),
      sequence_number: toInt(step.sequence_number),
      test_date: step.test_date ?? new Date().toISOString().slice(0, 10),
      target_time: step.target_time ?? null,
      cc_expiration: step.cc_expiration ?? null,
      dte: toInt(step.dte),
      stock_price_used: toReal(step.stock_price_used),
      stock_open: toReal(step.stock_open),
      stock_high: toReal(step.stock_high),
      stock_low: toReal(step.stock_low),
      stock_close: toReal(step.stock_close),
      assignment_strike: toReal(step.assignment_strike),
      cc_strike: toReal(step.cc_strike),
      volatility_used: toReal(step.volatility_used),
      volatility_source: step.volatility_source ?? null,
      risk_free_rate: toReal(step.risk_free_rate),
      dividend_yield: toReal(step.dividend_yield),
      bs_call_premium: toReal(step.bs_call_premium),
      premium_estimated: toReal(step.premium_estimated),
      premium_conservative: toReal(step.premium_conservative),
      conservative_factor: toReal(step.conservative_factor),
      cc_yield_pct: toReal(step.cc_yield_pct),
      cc_yield_conservative_pct: toReal(step.cc_yield_conservative_pct),
      cc_sold_theoretical: toIntBool(step.cc_sold_theoretical) ?? 0,
      not_sold_reason: step.not_sold_reason ?? null,
      best_threshold_reached: toReal(step.best_threshold_reached),
      threshold_0_5_hit: toIntBool(step.threshold_0_5_hit),
      threshold_0_75_hit: toIntBool(step.threshold_0_75_hit),
      threshold_1_0_hit: toIntBool(step.threshold_1_0_hit),
      threshold_1_5_hit: toIntBool(step.threshold_1_5_hit),
      threshold_2_0_hit: toIntBool(step.threshold_2_0_hit),
      threshold_2_5_hit: toIntBool(step.threshold_2_5_hit),
      threshold_3_0_hit: toIntBool(step.threshold_3_0_hit),
      threshold_4_0_hit: toIntBool(step.threshold_4_0_hit),
      threshold_5_0_hit: toIntBool(step.threshold_5_0_hit),
      threshold_6_0_hit: toIntBool(step.threshold_6_0_hit),
      opportunity_intraday_detected: toIntBool(step.opportunity_intraday_detected) ?? 0,
      intraday_best_threshold_reached: toReal(step.intraday_best_threshold_reached),
      result_at_expiration: step.result_at_expiration ?? null,
      called_away_theoretical: toIntBool(step.called_away_theoretical),
      expired_otm: toIntBool(step.expired_otm),
      data_quality: step.data_quality ?? null,
      raw_json: JSON.stringify(step.raw ?? step),
      created_at: step.created_at ?? nowIso,
      updated_at: nowIso,
    });
  }

  async function listCcSteps(theoreticalCycleId) {
    await ensureInitialized();
    const conn = ensureDbSync();
    return conn
      .prepare("SELECT * FROM theoretical_cc_steps WHERE theoretical_cycle_id = @id ORDER BY sequence_number ASC")
      .all({ id: String(theoreticalCycleId) });
  }

  async function getSummary() {
    await ensureInitialized();
    const conn = ensureDbSync();
    const cyclesTotal = conn.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles").get();
    const cyclesOpen = conn.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE status = 'open'").get();
    const cyclesClosed = conn.prepare("SELECT COUNT(*) AS cnt FROM theoretical_wheel_cycles WHERE status != 'open'").get();
    const ccStepsTotal = conn.prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps").get();
    const ccSoldTotal = conn.prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_sold_theoretical = 1").get();
    const ccWaitTotal = conn.prepare("SELECT COUNT(*) AS cnt FROM theoretical_cc_steps WHERE cc_sold_theoretical = 0").get();
    const tickersCount = conn.prepare("SELECT COUNT(DISTINCT ticker) AS cnt FROM theoretical_wheel_cycles").get();
    return {
      cycles_total: cyclesTotal?.cnt ?? 0,
      cycles_open: cyclesOpen?.cnt ?? 0,
      cycles_closed: cyclesClosed?.cnt ?? 0,
      cc_steps_total: ccStepsTotal?.cnt ?? 0,
      cc_sold_total: ccSoldTotal?.cnt ?? 0,
      cc_wait_total: ccWaitTotal?.cnt ?? 0,
      tickers_count: tickersCount?.cnt ?? 0,
    };
  }

  return {
    ensureInitialized,
    listCycles,
    listCyclesByTicker,
    getCycleById,
    upsertCycle,
    listCcSteps,
    upsertCcStep,
    getSummary,
    sqlitePath,
  };
}
